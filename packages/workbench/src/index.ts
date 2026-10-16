import { compactMessages } from "./context.ts";
import {
  recoveryRequest,
  runtimeSelection,
  recoveryOperationMap,
  recoveryPreview,
  recoveryResult,
  type RecoveryRequest,
  type RecoveryApply,
} from "./recovery-jobs.ts";
import { toolCatalog } from "./tool-catalog.ts";
import { managedDocumentAdapter } from "./managed-documents.ts";
import {
  recoveryRuntime,
  localOperationJournal,
  digest,
  type Json,
} from "../../runtime/src/index.ts";
import { NVIDIA_URL, QWEN_URL, PROVIDER_PRESETS } from "./provider-defaults.ts";
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
  hookSucceeded,
  runHook,
  HOOK_TIMEOUT_BOUNDS,
  type HookResult,
  type CompactionResult,
} from "./agents.ts";
import {
  LOCAL_AGENT_GRANT_AUDIENCE,
  LOCAL_AGENT_PRINCIPAL_ID,
  LocalAgentIdentityIssuer,
  type IssuedLocalAgentGrant,
  type LocalAgentGrantRequest,
  type LocalAgentIdentity,
} from "./agent-identity.ts";
import {
  defaultHarnessSettings,
  harnessSettingsPatch,
  resolveHarnessSettings,
  type HarnessSettings,
} from "./harness-settings.ts";
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
import {
  devKeyProvider,
  retainedKeyProvider,
  sha256Hex,
} from "../../ledger/src/sign.ts";
import {
  canonicalJson,
  entryHash,
  GENESIS_PREV,
} from "../../ledger/src/canonical.ts";
import { signingPreimage } from "../../ledger/src/index.ts";
import { dataDir } from "../../ledger/src/paths.ts";
import { envValue, normalizeOwnedEnv } from "../../ledger/src/env-compat.ts";
import {
  resolveVerificationKey,
  type VerificationKey,
} from "../../ledger/src/verify-key.ts";
import type { KeyProvider } from "../../ledger/src/index.ts";
import { verifyChain, readLedgerEntries } from "../../ledger/src/verify.ts";
import type { JsonlEntry } from "../../ledger/src/store.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import {
  DEFAULT_POLICY,
  listPolicyProfiles,
  resolvePolicyProfile,
} from "./policy-profile.ts";
import { mineLearnedRules } from "./learned-rules.ts";
import { mineHarnessEntries, type HarnessEntry } from "./learned-harness.ts";
import type { SpawnSubagentOptions } from "./subagents.ts";
import {
  validateIdempotencyKey,
  validateSpawnPrompt,
  spawnWorkspaceName,
  subsetTools,
} from "./subagents.ts";
import {
  formatForPrompt,
  queryTermsFrom,
  rankEntries,
} from "./harness-ranking.ts";
import {
  applyProposal,
  validateProposal,
  type AppliedEdit,
  type RefinementEdit,
  type RefinementProposal,
} from "./refine-pass.ts";
import { resolveLensCount, reviewRanNote, serviceHarnessBoundary } from "./harness-runtime.ts";
import {
  resolveRefineGates,
  type GateSurface,
} from "./refine-gate.ts";
import {
  arm,
  initialTriggerState,
  onBranchMove,
  recordSettledTurn,
  requestManualReview,
  type ServiceResult,
  type TriggerState,
} from "./refine-trigger.ts";
import { loadPolicy, type ValidPolicy } from "../../policy/src/rules.ts";
import { decide, type PolicyDecision } from "../../policy/src/decide.ts";
import { policyDigest } from "../../policy/src/digest.ts";
import {
  buildAttribution,
  type LedgerAttribution,
} from "../../ledger/src/attribution.ts";
import {
  buildReversal,
  type LedgerReversal,
} from "../../ledger/src/reversal.ts";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  attestLedger,
  type AttestationDocument,
} from "../../ledger/src/attest.ts";
import { createNomoClient, type NomoClient } from "../../sdk/src/client.ts";
import { HoldDeniedError } from "../../sdk/src/errors.ts";
import {
  catalogFor,
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
  readonly status:
    | "running"
    | "queued"
    | "idle"
    | "cancelled"
    | "failed"
    | "unknown"
    | "paused";
  readonly events: readonly SessionEvent[];
  readonly continuationCount: number;
  readonly runTokenCount: number;
};
/** Model ids VOID once shipped as its default. They are retired on sight: the
 * workspace picks from its own validated catalog or has no model at all. */
const RETIRED_MODEL_IDS = [
  "openai-fast",
  "muse-spark-1.3-contributor-free",
  "z-ai/glm-5.3-free",
];
/** Domain separator for the agent-conversation request digest, versioned
 * because the derivation changed: v1 hashed only the messages added since the
 * previous turn plus a count, so two conversations reaching the same tail with
 * different histories produced the same value. A recorded digest is opaque and
 * stays valid either way; only newly computed values use the chain. */
const REQUEST_DIGEST_DOMAIN = "void.workbench.request.v2";

/**
 * The byte ceiling on a session view's retained events. The stream heartbeat
 * and the events endpoint both rescan this list, so a long-running session
 * would otherwise grow its own per-request cost without bound. Events beyond
 * the ceiling are dropped oldest first; the sequence numbers stay monotonic,
 * so a resuming subscriber sees the gap as an incomplete history rather than
 * a silent one.
 */
export const WORKBENCH_VIEW_MAX_EVENT_BYTES = 1024 * 1024;

/**
 * The byte total of the events each session view currently retains, keyed by
 * the array the total describes. Keying on the array rather than the session
 * id means a view that arrived from storage is remeasured instead of trusted,
 * and a discarded session is collected with its own events.
 */
const viewEventBytes = new WeakMap<readonly SessionEvent[], number>();

/**
 * Drops the oldest events until the retained list is within the ceiling. The
 * running total for the previous list is reused when appending one event, so
 * the cost is proportional to the events dropped rather than to the whole
 * transcript.
 */
function trimViewEvents(
  session: Session,
  events: SessionEvent[],
): SessionEvent[] {
  const previous = session.view.events;
  // The previous total is reused only when this call extends the very array it
  // described; a view that arrived from storage is measured in full instead.
  const carried = viewEventBytes.get(previous);
  const fresh = carried === undefined ? events : events.slice(previous.length);
  let bytes = carried ?? 0;
  for (const event of fresh) bytes += Buffer.byteLength(JSON.stringify(event));
  let first = 0;
  while (bytes > WORKBENCH_VIEW_MAX_EVENT_BYTES && first < events.length - 1) {
    bytes -= Buffer.byteLength(JSON.stringify(events[first]!));
    first += 1;
  }
  const retained = first === 0 ? events : events.slice(first);
  viewEventBytes.set(retained, bytes);
  return retained;
}

/**
 * One turn of the agent-conversation request digest chain.
 *
 * `previous` is the digest of every turn before this one, so a change anywhere
 * in the conversation reaches every later value without re-serialising the
 * prefix on each turn. `null` starts the chain; the recorded digest is opaque,
 * so a value produced by the older unchained derivation stays readable and only
 * newly computed turns use the chain.
 */
export function conversationRequestDigest(
  previous: string | null,
  model: string,
  messages: readonly unknown[],
  tools: readonly unknown[],
): Promise<string> {
  return sha256Hex(
    canonicalJson({
      domain: REQUEST_DIGEST_DOMAIN,
      previous,
      model,
      messages,
      tools,
    }),
  );
}
export { DEFAULT_POLICY };
export const AGENT_PRESETS = [
  {
    id: "default",
    name: "NOMO default",
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
 * The learned-entry block for one prompt, or "" when there is nothing to add.
 *
 * Entries arrive from the verified chain already merged with the operator's
 * approved overrides, so this only decides what the prompt sees: which entries
 * are relevant to this query, how many per kind, and how much of each one.
 *
 * A limit of zero returns nothing at all, which is the operator's way to keep
 * the harness out of the prompt without deleting what the chain recorded.
 *
 * Nothing here reaches `decide`. The block is context the model may read, not
 * an approval, and no entry's mined rule is consulted on this path.
 */
export function retrievalContext(
  entries: readonly HarnessEntry[],
  query: string,
  settings: HarnessSettings,
): string {
  const ranked = rankEntries(entries, queryTermsFrom({ user: query }), {
    perKindLimit: settings.contextEntryLimit,
    contentChars: settings.contextCharsPerEntry,
  });
  return formatForPrompt(ranked, new Date().toISOString());
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
        body.operationId === operationId &&
        body.decision === "execute:completed"
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
  constructor() {
    super(
      "Tool outcome is unknown. Stop and reconcile its evidence before continuing.",
    );
  }
}
/** A run that reached its wall-clock ceiling was aborted, not finished. Its
 * outcome was never proven, so it reports as `unknown` the way an unknown tool
 * outcome does rather than as a failure a retry would clear: the operator has
 * to reconcile the evidence before the session can continue. */
class RunTimeout extends Error {
  constructor(timeoutMs: number) {
    super(
      `Run exceeded its ${timeoutMs}ms limit and was aborted. Its outcome is unproven. Reconcile its evidence before continuing.`,
    );
  }
}
class ProviderSetupSuperseded extends Error {
  constructor() {
    super("Provider setup was superseded by a newer configuration.");
  }
}
type Connector = McpConfig & {
  id: string;
  name: string;
  tools: McpTool[];
  consentState: "staged" | "probed" | "confirmed";
};
type Session = {
  /** The run that passed its before-run gate, or undefined once it is
   * torn down. A local agent grant is only issued against a gated run. */
  proxyGrantReadyRunId?: string;
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
  client?: NomoClient;
  tools?: McpTool[];
  connections?: Record<string, McpConfig & { sessionId?: string }>;
  config?: Pick<ProviderConfig, "baseUrl" | "kind">;
  controller: AbortController;
  provider?: CompatibleProvider;
};

/** Model tools always cross the existing VOID SDK. A provider has no shell or
 * filesystem authority; operators configure the MCP upstream on the runtime. */
const REFINEMENT_SECRET_PATTERNS = [
  /\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?[^\s,;"']+/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
  /--(?:api[_-]?key|token|password|secret|key)(?:=|\s+)\S+/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{10,})\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

/** The proposal is scanned before it reaches the chain. A secret-shaped value
 * is refused wherever it comes from: the model inventing it, a configured
 * credential it was told about, or a value it copied out of the workspace
 * documents. The documents are the material the reviewer was given, so a
 * pattern the documents never hold cannot refuse a proposal that quotes
 * ordinary text, and a value the model paraphrases is not detectable. The
 * operator is expected not to place credentials in the managed workspace in
 * the first place. */
function refinementTextIsSensitive(
  proposal: RefinementProposal,
  knownSecrets: readonly string[],
): boolean {
  const text = JSON.stringify(proposal);
  return (
    REFINEMENT_SECRET_PATTERNS.some((pattern) => pattern.test(text)) ||
    knownSecrets.some((secret) => secret.length >= 4 && text.includes(secret))
  );
}

/**
 * A proposal awaiting an operator decision, reconstructed from the signed
 * workspace chain rather than held only in process memory.
 */
type PendingApproval = {
  readonly proposal: RefinementProposal;
  readonly digest: string;
  readonly at: string;
  readonly atSeq: number;
};

export type PendingHarnessProposal = {
  readonly digest: string;
  readonly at: string;
  readonly atSeq: number;
  readonly summary: string;
  readonly proposal: RefinementProposal;
  /** Compatibility view for callers that only render prompt addenda. */
  readonly addendum: string;
};
/** What `/harness review` gets back.
 *
 * `armed` is not a refusal: the request is recorded and a later boundary will
 * serve it, either because a run is in progress or because a gate that holds
 * (cooldown, nothing new, in flight) kept it. `refused` means the request has
 * nowhere to run: the session is unknown, no provider is connected, or the
 * gate cannot open at all. `note` is always the sentence the operator reads. */
export type ManualReviewResult = {
  readonly kind: "refused" | "armed" | "ran" | "declined" | "failed";
  readonly note: string;
};
export class Workbench {
  private readonly env: Readonly<NodeJS.ProcessEnv>;
  private readonly permissionMode: PermissionMode;
  private provider: CompatibleProvider | undefined;
  private providerFailureState: {
    status: number;
    retryAt: string | null;
  } | null = null;
  /**
   * Environment sources already probed and refused in this process, keyed by
   * their preset base URL. Per source, because two keys are two statements
   * about two different hosts: a rejected NVIDIA key must not veto the
   * DashScope attempt behind it. The set also stops every `providerState` poll
   * from repeating a request against the same refused key; an explicit
   * reconnect clears it, because the operator asking again is a new attempt.
   */
  private readonly envProbeFailures = new Set<string>();
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
  private readonly workspaceKeySecret: string | undefined;
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
  private hooks: Hook[] = [];
  private readonly hookAllowlist: readonly string[];
  private harness: HarnessSettings = defaultHarnessSettings();
  /**
   * Per-session refinement trigger state.
   *
   * Deliberately in memory and not in the encrypted workspace: a crash costs a
   * delayed review, never a wrong one, because the state that decides whether
   * to spend a model call is derived from the chain again at the next boundary.
   * Persisting it would mean a stored timestamp deciding what the product does.
   */
  private readonly harnessTriggers = new Map<string, TriggerState>();
  /**
   * The harness boundary running per session, if any.
   *
   * One boundary at a time is what makes "one operator intent, one model
   * call" true: a second manual request joins the running round for its
   * answer instead of starting another, and a settled turn that arrives
   * mid-round leaves its turn counted for the next boundary. The joiner
   * reads the outcome only and never touches the chain, so the rule that an
   * in-flight round is never joined for writes still holds.
   */
  private readonly harnessBoundariesInFlight = new Map<
    string,
    { readonly run: Promise<ServiceResult>; readonly lenses: number }
  >();
  private readonly localIdentityIssuer = new LocalAgentIdentityIssuer();
  /** In-flight learning passes, awaited by `settled()` and never by `jobs`. */
  private readonly harnessJobs = new Set<Promise<void>>();
  /** The timeout `NOMO_HOOK_TIMEOUT_MS` asked for, or undefined when the
   * launcher set none. Kept apart from the resolved setting so an explicit
   * runtime environment still wins: it is the more specific statement about
   * this process, and an operator who set it before the workbench loaded must
   * not silently lose it to a value stored in the workspace. */
  private readonly hookTimeoutFromEnv: number | undefined;
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
    // The harness boundary is awaited here but is deliberately not part of
    // `jobs`: it runs after the turn's result is final, so holding the turn's
    // job open across it would make a session that reads `idle` still look
    // busy, and a document edit would be refused for a learning pass that has
    // nothing to do with it.
    // One snapshot is not enough: a turn registers its learning pass while the
    // turn's own job is still resolving, so the pass that this call was asked
    // about often does not exist yet when the list is taken. Waiting again is
    // what makes `settled` mean every turn that started has finished,
    // including the pass that turn scheduled.
    while (this.jobs.size > 0 || this.harnessJobs.size > 0)
      await Promise.allSettled([...this.jobs.values(), ...this.harnessJobs]);
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
    // One normalization, at construction, before anything below reads a
    // setting. A launcher that configured the product under `VOID_*` before
    // the rename hands that environment in unchanged, and every reader below
    // keeps its single `NOMO_*` lookup.
    const resolved = normalizeOwnedEnv({ ...env });
    // The workspace key is resolved through the legacy-aware reader: a machine
    // configured before the rename keeps its keychain-backed storage instead of
    // silently starting a second encrypted-local store.
    this.workspaceKeySecret = envValue(resolved, "NOMO_WORKSPACE_KEY");
    this.permissionMode = serverPermissionMode(
      envValue(resolved, "NOMO_PERMISSION_MODE") ?? DEFAULT_LOCAL_PERMISSION_MODE,
    );
    this.keyStorage = envValue(resolved, "NOMO_WORKSPACE_KEY")
      ? "os-keychain"
      : "encrypted-local";
    this.env = resolved;
    // The workspace key is a secret. It selected storage above and is dropped
    // here, so no retained copy of it can reach a log, a report or a crash
    // dump. Both spellings go, because a legacy one that was kept would be the
    // same secret under a name nothing redacts.
    delete (this.env as NodeJS.ProcessEnv).NOMO_WORKSPACE_KEY;
    delete (this.env as NodeJS.ProcessEnv).VOID_WORKSPACE_KEY;
    this.hookAllowlist = Workbench.hookAllowlist(this.env);
    // Precedence: an explicit NOMO_HOOK_TIMEOUT_MS wins over the stored
    // harness setting, and the stored setting wins over the default. The env
    // is the launcher's statement about this process, so an operator who set
    // it must not lose it to a workspace value written before it. Clamped at
    // both ends either way: a hook cannot be made un-timeouttable, and a short
    // timeout only costs a well-behaved hook more than a long one.
    const hookTimeout = envValue(this.env, "NOMO_HOOK_TIMEOUT_MS");
    const requestedHookTimeout = Number(hookTimeout);
    this.hookTimeoutFromEnv =
      hookTimeout && Number.isFinite(requestedHookTimeout)
        ? Math.min(
            HOOK_TIMEOUT_BOUNDS.max,
            Math.max(HOOK_TIMEOUT_BOUNDS.min, requestedHookTimeout),
          )
        : undefined;
    this.fetcher = fetcher;
    this.storage = new LocalStorage(
      envValue(this.env, "NOMO_DATA_DIR") ??
        join(
          envValue(this.env, "NOMO_LEDGER_DIR") ?? join(dataDir(homedir())),
          "workbench",
        ),
      envValue(this.env, "NOMO_WORKSPACE_KEY"),
    );
    const saved = this.storage.read<{
      preferences?: Record<string, string>;
      harnessSettings?: Record<string, unknown>;
      requests?: Record<string, { digest: string; sessionId: string }>;
      approvalHistory?: unknown[];
      config?: ProviderConfig;
      ignoreEnvironment?: boolean;
      profiles?: Record<string, ProviderConfig>;
      catalog: readonly Model[];
      connectors: Array<
        Omit<Connector, "consentState"> & {
          consentState?: Connector["consentState"];
        }
      >;
      documents: Record<string, WorkspaceState>;
      evidence: Record<string, JsonlEntry[]>;
      recoveryRequests?: Record<string, RecoveryRequest>;
      agentProfiles?: AgentProfile[];
      hooks?: Hook[];
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
          new CompatibleProvider(config, fetcher, () => this.harness);
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
      // Resolved, not trusted: a hand-edited or truncated snapshot must not be
      // able to put the run path in range of a limit nobody chose.
      this.harness = resolveHarnessSettings(saved.harnessSettings);
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
        if (item.consentState)
          return { ...item, consentState: item.consentState };
        migrated = true;
        return { ...item, consentState: "staged", tools: [] };
      });
      this.documents = saved.documents;
      this.evidence = saved.evidence;
      this.recoveryRequests = saved.recoveryRequests ?? {};
      this.agentProfiles = (saved.agentProfiles ?? []).map((profile) =>
        validateAgentProfile(profile),
      );
      // A stored hook is re-checked against the *current* operator allowlist,
      // not trusted because it was accepted once. Narrowing the allowlist on
      // the runtime must retire the hooks it no longer covers, so the snapshot
      // can never outlive the authorisation that admitted it.
      this.hooks = (saved.hooks ?? []).flatMap((hook) => {
        try {
          return [validateHook(hook, this.hookAllowlist)];
        } catch {
          return [];
        }
      });
      this.projectList = saved.projects ?? [];
      if (this.config)
        this.provider = new CompatibleProvider(
          this.config,
          fetcher,
          () => this.harness,
        );
      for (const item of saved.sessions) {
        const sessionBaseUrl =
          typeof item.config?.baseUrl === "string"
            ? item.config.baseUrl
            : typeof item.view.provider === "string"
              ? item.view.provider
              : undefined;
        if (item.config && Object.hasOwn(item.config, "apiKey"))
          migrated = true;
        const sessionKind =
          item.config?.kind === "anthropic"
            ? "anthropic"
            : item.config?.kind === "compatible" ||
                item.config?.kind === "openai"
              ? "compatible"
              : undefined;
        if (item.config && item.config.kind !== sessionKind) migrated = true;
        const savedProvider = sessionBaseUrl
          ? (this.profiles[sessionBaseUrl] ??
            (this.config?.baseUrl === sessionBaseUrl ? this.config : undefined))
          : undefined;
        const provider =
          sessionKind && savedProvider?.kind === sessionKind
            ? savedProvider
            : undefined;
        this.sessions.set(item.view.id, {
          ...item,
          config: sessionBaseUrl
            ? { baseUrl: sessionBaseUrl, kind: sessionKind }
            : undefined,
          view: {
            ...item.view,
            status:
              item.view.status === "running"
                ? "unknown"
                : item.view.status === "queued"
                  ? "paused"
                  : item.view.status,
          },
          provider: provider
            ? new CompatibleProvider(provider, fetcher, () => this.harness)
            : undefined,
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
      harnessSettings: this.harness,
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
      hooks: this.hooks,
      projects: this.projectList,
      sessions: [...this.sessions.values()].map(
        ({
          view,
          messages,
          messageIds,
          agentProfile,
          recoveryBlock,
          queuedPrompt,
          config,
          tools,
          connections,
        }) => ({
          view,
          messages,
          messageIds,
          agentProfile,
          recoveryBlock,
          queuedPrompt,
          config: config
            ? { baseUrl: config.baseUrl, kind: config.kind }
            : undefined,
          tools,
          connections,
        }),
      ),
    });
    this.hasState = true;
  }

  /**
   * The operator hook allowlist, read once from the runtime environment.
   *
   * It is `NOMO_HOOK_COMMANDS`, a JSON array of exact command strings, for the
   * same reason `NOMO_UPSTREAM_COMMAND` is one: the launcher that starts this
   * process is the only place a command can be authorised. It deliberately
   * lives on the runtime rather than in the encrypted workspace snapshot,
   * because a snapshot is written by whoever holds the workbench API and read
   * *by* the same API, a hook author who could persist an allowlist entry
   * could authorise the command their own hook runs. Nothing that arrives on
   * `upsertHook(input)` reaches this list; `input` is only ever checked *against*
   * it, so a caller who can add a hook cannot authorise it.
   */
  private static hookAllowlist(
    env: Readonly<NodeJS.ProcessEnv>,
  ): readonly string[] {
    const commands = envValue(env, "NOMO_HOOK_COMMANDS");
    if (!commands) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(commands);
    } catch {
      throw new Error(
        "NOMO_HOOK_COMMANDS must be a JSON array of command strings.",
      );
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (item) => typeof item === "string" && item.trim().length > 0,
      )
    )
      throw new Error(
        "Configure NOMO_HOOK_COMMANDS on the runtime with the hookable commands as a JSON array.",
      );
    return [...new Set(parsed.map((item) => (item as string).trim()))];
  }
  async configure(config: ProviderConfig): Promise<readonly Model[]> {
    const generation = ++this.providerGeneration;
    this.providerSetupCount++;
    try {
      config = normalizeProviderConfig({
        ...config,
        apiKey: config.apiKey || this.profiles[config.baseUrl]?.apiKey || "",
      });
      const provider = new CompatibleProvider(
        config,
        this.fetcher,
        () => this.harness,
      );
      const models = await catalogFor(provider, config);
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
        models.find((model) => model.id === this.preferences.defaultModel)
          ?.id ?? models[0]!.id;
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
    if (options.reconnectEnvironment) {
      if (this.ignoreEnvironment) {
        this.ignoreEnvironment = false;
        try {
          this.persist();
        } catch (error) {
          this.ignoreEnvironment = true;
          throw error;
        }
      }
      // The operator asked for the environment again, so earlier refusals are
      // stale: each source gets one fresh attempt instead of a veto replayed
      // from an earlier poll.
      this.envProbeFailures.clear();
    }
    if (
      !this.provider &&
      !this.ignoreEnvironment &&
      this.env.NVIDIA_API_KEY &&
      !this.envProbeFailures.has(NVIDIA_URL)
    ) {
      try {
        await this.configure({
          baseUrl: NVIDIA_URL,
          apiKey: this.env.NVIDIA_API_KEY,
        });
      } catch (error) {
        if (
          !this.ignoreEnvironment &&
          !(error instanceof ProviderSetupSuperseded)
        ) {
          this.envProbeFailures.add(NVIDIA_URL);
          this.recordProviderFailure(error);
        }
      }
    }
    if (
      !this.provider &&
      !this.ignoreEnvironment &&
      this.env.DASHSCOPE_API_KEY &&
      !this.envProbeFailures.has(QWEN_URL)
    ) {
      try {
        await this.configure({
          baseUrl: QWEN_URL,
          apiKey: this.env.DASHSCOPE_API_KEY,
          model: "qwen3.8-flash",
        });
      } catch (error) {
        if (
          !this.ignoreEnvironment &&
          !(error instanceof ProviderSetupSuperseded)
        ) {
          this.envProbeFailures.add(QWEN_URL);
          this.recordProviderFailure(error);
        }
      }
    }
    const hasCredential = Boolean(
      this.config?.apiKey ||
      (!this.ignoreEnvironment &&
        (this.env.NVIDIA_API_KEY || this.env.DASHSCOPE_API_KEY)),
    );
    const derived = providerStateFromFailure(
      this.provider !== undefined,
      this.providerFailureState,
      hasCredential,
    );
    return {
      connected: this.provider !== undefined,
      setupRequired: derived.status === "setup-required",
      models: this.catalog,
      keyStorage: this.keyStorage,
      baseUrl: this.config?.baseUrl,
      kind: this.config?.kind,
      profiles: Object.keys(this.profiles),
      presets: PROVIDER_PRESETS,
      // A workspace with nothing configured has no provider, and says so
      // instead of naming one vendor.
      providerId: this.config
        ? (PROVIDER_PRESETS.find((p) => p.baseUrl === this.config?.baseUrl)
            ?.id ?? "custom")
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
        ...AGENT_PRESETS.map(({ id, name, description }) => ({
          id,
          name,
          description,
        })),
        ...this.agentProfiles.map(({ id, name }) => ({
          id,
          name,
          description:
            "Custom profile with explicit tools and bounded execution.",
        })),
      ],
      profiles: structuredClone(this.agentProfiles),
      policyProfiles: listPolicyProfiles(this.env.NOMO_POLICY_PATH),
      hooks: structuredClone(this.hooks),
      hookCommands: [...this.hookAllowlist],
      // Derived, not asserted: a hardcoded `true` cannot disagree with a test
      // that reads it, so a caller checking this flag was told nothing. The
      // truth is that hooks are executable exactly when some command is on the
      // operator allowlist, `validateHook` refuses everything else, and with
      // an empty allowlist no hook can be saved or run at all.
      hooksSupported: this.hookAllowlist.length > 0,
    };
  }
  upsertAgent(input: unknown): AgentProfile {
    const profile = validateAgentProfile(input);
    if (AGENT_PRESETS.some((preset) => preset.id === profile.id))
      throw new Error("Agent id belongs to a built-in preset.");
    const policy = resolvePolicyProfile(
      profile.policyProfile,
      this.env.NOMO_POLICY_PATH,
    );
    if (!policy.ok)
      throw new Error(
        `Unknown policy profile ${profile.policyProfile}. ${policy.reason}.`,
      );
    const available = new Set(
      [
        ...workspaceTools,
        ...this.connectors.flatMap((connector) => connector.tools),
      ].map((tool) => tool.name),
    );
    if (profile.allowedTools.some((name) => !available.has(name)))
      throw new Error("Agent allowlist contains an unavailable tool.");
    const before = this.agentProfiles;
    this.agentProfiles = [
      ...before.filter((candidate) => candidate.id !== profile.id),
      profile,
    ];
    this.hasState = true;
    try {
      this.persist();
    } catch (error) {
      this.agentProfiles = before;
      throw error;
    }
    return structuredClone(profile);
  }
  /**
   * Register a hook. `input` chooses *which* allowlisted command fires on
   * *which* event; it can never introduce a command. The allowlist is the
   * runtime's, so a request that arrives with its own copy of one is
   * compared against the operator's list and dropped if it is not on it.
   */
  upsertHook(input: unknown): Hook {
    const hook = validateHook(input, this.hookAllowlist);
    const before = this.hooks;
    this.hooks = [
      ...before.filter((candidate) => candidate.id !== hook.id),
      hook,
    ];
    this.hasState = true;
    try {
      this.persist();
    } catch (error) {
      this.hooks = before;
      throw error;
    }
    return structuredClone(hook);
  }
  /**
   * Fire every enabled hook registered for `event`, in registration order,
   * and report each result. A `before-run` refusal is returned to the caller
   * as a failed result rather than thrown here, so the loop decides what a
   * refusal means for the run instead of the runner guessing.
   */
  private async fireHooks(
    event: Hook["event"],
    context: Record<string, unknown> = {},
    session?: Session,
  ): Promise<readonly HookResult[]> {
    const matching = this.hooks.filter((hook) => hook.event === event);
    if (!matching.length) return [];
    const results: HookResult[] = [];
    for (const hook of matching) {
      // A disabled hook is filtered before it reaches runHook, so the process
      // is never created; runHook refuses it again as a second line.
      if (!hook.enabled) continue;
      const result = await runHook(hook, context, {
        timeoutMs: this.hookTimeoutFromEnv ?? this.harness.hookTimeoutMs,
        env: this.env,
      });
      results.push(result);
      if (session)
        this.event(
          session,
          "tool",
          hookSucceeded(result)
            ? `${hook.id}: hook exited ${result.code}`
            : `${hook.id}: hook ${result.outcome}${result.code === null ? "" : ` (${result.code})`}`,
          { hook: result, ...context },
          "hook.result",
        );
    }
    return results;
  }
  listProjects(): readonly {
    id: string;
    name: string;
    root: string;
    updatedAt: string;
  }[] {
    return this.projectList
      .map((project) => ({ ...project }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  projects() {
    return this.listProjects();
  }
  upsertProject(input: { id?: string; name: string; root: string }): {
    id: string;
    name: string;
    root: string;
    updatedAt: string;
  } {
    if (
      !input ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 160
    )
      throw new Error("Project name must contain 1..160 characters.");
    if (
      typeof input.root !== "string" ||
      !input.root.trim() ||
      input.root.length > 4096
    )
      throw new Error("Project root must contain 1..4096 characters.");
    if (
      input.id !== undefined &&
      (typeof input.id !== "string" ||
        !/^[A-Za-z0-9][\w-]{0,119}$/.test(input.id))
    )
      throw new Error("Invalid project id.");
    const name = input.name.trim(),
      root = input.root.trim();
    const existing = this.projectList.find((p) =>
      input.id ? p.id === input.id : p.root === root,
    );
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
      throw new Error(
        "Stop active sessions before disconnecting the provider.",
      );
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
      for (const item of previous.sessions)
        item.session.provider = item.provider;
      throw error;
    }
  }
  private view(session: Session): SessionView {
    const jobId =
      session.recoveryBlock?.jobId ?? session.view.lastRecoveryJob?.jobId;
    return {
      ...session.view,
      lastRecoveryJob: jobId ? { jobId } : undefined,
      contextMessages: session.messages.length,
      state:
        session.view.status === "cancelled" && this.jobs.has(session.view.id)
          ? "stopping"
          : deriveRunState(session.view.status, session.view.events),
    };
  }
  list(): readonly SessionView[] {
    return this.allViews().map((view) => ({ ...view, events: [] }));
  }
  availableTools(id?: string) {
    const session = id ? this.sessions.get(id) : undefined;
    if (id && !session) throw new Error("Session not found.");
    const tools = (
      session
        ? (session.tools ?? [...workspaceTools])
        : [
            ...workspaceTools,
            ...this.connectors
              .filter((c) => c.consentState === "confirmed")
              .flatMap((c) =>
                c.tools.map((tool) => ({ ...tool, connectorId: c.id })),
              ),
          ]
    ).filter((tool) => this.toolAllowedInMode(tool));
    return {
      scope: id ? "session" : "configured",
      tools: toolCatalog(tools, [
        ...this.connectors.map((c) => c.token),
        ...Object.values(session?.connections ?? {}).map((c) => c.token),
      ]),
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
  private countRunning(): number {
    return [...this.sessions.values()].filter(
      (session) => session.view.status === "running",
    ).length;
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
      throw new Error(
        "Wait for provider setup to finish before starting a session.",
      );
    if (background && this.queued.size >= this.harness.maxQueuedRuns)
      throw new Error(
        `Background queue is full (${this.harness.maxQueuedRuns} queued runs). Stop a queued run before adding another.`,
      );
    const running = this.countRunning();
    if (!background && running >= this.harness.maxConcurrentRuns)
      throw new Error(
        `Concurrent run limit reached (${this.harness.maxConcurrentRuns}). Wait for a running session to finish or increase the limit.`,
      );
    const selectedAgent = AGENT_PRESETS.find(
      (item) => item.id === (agent ?? this.preferences.defaultAgentPreset),
    );
    const selectedProfile = this.agentProfiles.find(
      (profile) => profile.id === agent,
    );
    if (agent && !selectedAgent && !selectedProfile)
      throw new Error("Unknown agent preset or profile.");
    const selectedGeneration = this.providerGeneration,
      selectedProvider = this.provider,
      selectedConfig = this.config;
    if (!this.catalog.some((item) => item.id === model))
      throw new Error("Select a model from the validated catalog.");
    if (this.closing)
      throw new Error(
        "Wait for the active session or cancel it before starting another.",
      );
    let command: unknown;
    try {
      command = JSON.parse(this.env.NOMO_UPSTREAM_COMMAND ?? "null");
    } catch {
      throw new Error("NOMO_UPSTREAM_COMMAND must be a JSON array.");
    }
    if (
      command !== null &&
      (!Array.isArray(command) ||
        !command.length ||
        !command.every((item) => typeof item === "string" && item.length > 0))
    )
      throw new Error(
        "Configure NOMO_UPSTREAM_COMMAND on the runtime with the MCP server command as a JSON array.",
      );
    if (command && !this.env.NOMO_POLICY_PATH)
      throw new Error("Configure NOMO_POLICY_PATH before starting an agent.");
    if (!prompt.trim() || prompt.length > this.harness.maxPromptCharacters)
      throw new Error(
        `Enter a prompt between 1 and ${this.harness.maxPromptCharacters} characters.`,
      );
    const id = randomUUID();
    const workspace = `agent-${id}`;
    const client = Array.isArray(command)
      ? createNomoClient({
          workspace,
          ledgerDir:
            this.env.NOMO_LEDGER_DIR ?? join(dataDir(homedir()), "ledger"),
          connect: { upstreamCommand: command },
          policyPath: this.env.NOMO_POLICY_PATH!,
          factsPath: this.env.NOMO_FACTS_PATH,
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
        connections[connector.id] = {
          ...connector,
          sessionId: listed.sessionId,
        };
        tools.push(
          ...listed.tools.map((tool) => ({
            ...tool,
            connectorId: connector.id,
          })),
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
    const runningNow = this.countRunning();
    if (
      this.closing ||
      (!background &&
        (this.jobs.size || runningNow >= this.harness.maxConcurrentRuns))
    ) {
      client?.close();
      throw new Error(
        `Concurrent run limit reached (${this.harness.maxConcurrentRuns}). Wait for a running session to finish or increase the limit.`,
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
        continuationCount: 0,
        runTokenCount: 0,
      },
      messages: [{ role: "system", content: systemInstruction }],
      agentProfile: selectedProfile
        ? structuredClone(selectedProfile)
        : undefined,
      queuedPrompt: queued ? prompt : undefined,
      client,
      tools: (selectedProfile
        ? tools.filter((tool) =>
            selectedProfile.allowedTools.includes(tool.name),
          )
        : tools
      ).filter((tool) => this.toolAllowedInMode(tool)),
      connections,
      config: selectedConfig
        ? { baseUrl: selectedConfig.baseUrl, kind: selectedConfig.kind }
        : undefined,
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
      throw new Error(
        "Run outcome is unknown. Reconcile its evidence before continuing.",
      );
    if (session.recoveryBlock)
      throw new Error(
        "Recovery is unresolved. Resume the approved recovery job before continuing.",
      );
    if (!prompt.trim() || prompt.length > this.harness.maxPromptCharacters)
      throw new Error(
        `Enter a prompt between 1 and ${this.harness.maxPromptCharacters} characters.`,
      );
    const running = this.countRunning();
    if (running >= this.harness.maxConcurrentRuns)
      throw new Error(
        `Concurrent run limit reached (${this.harness.maxConcurrentRuns}). Wait for a running session to finish or increase the limit.`,
      );
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
        throw new Error(
          "Reconnect the provider used by this conversation before continuing.",
        );
      session.provider = this.provider;
    }
    session.controller = new AbortController();
    const queued =
      session.view.status === "idle" && session.queuedPrompt === prompt;
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
        if (session.view.status !== "unknown")
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
    if (
      this.jobs.size ||
      session.view.status === "running" ||
      session.view.status === "queued"
    )
      throw new Error("Wait for the active run to settle before compacting.");
    const before = session.messages.length;
    const compacted = compactMessages(id, session.messages, session.messageIds);
    session.messages = compacted.messages;
    session.messageIds = compacted.messageIds;
    session.view = {
      ...session.view,
      compaction: compacted.result,
      contextMessages: session.messages.length,
    };
    if (compacted.result.omittedMessageCount)
      this.event(
        session,
        "tool",
        "Context compacted.",
        {
          beforeMessages: before,
          afterMessages: session.messages.length,
          omittedMessages: compacted.result.omittedMessageCount,
        },
        "context.compacted",
      );
    // Compaction is the documented arming point for the harness. Without this
    // the trigger can never become pending, the gate refuses every boundary
    // with "not-armed", and the whole learning loop is dead code.
    this.harnessTriggers.set(
      id,
      arm(this.harnessTriggers.get(id) ?? initialTriggerState()),
    );
    this.persist();
    return compacted.result;
  }
  private drainQueued(): void {
    if (this.closing || this.jobs.size) return;
    const running = this.countRunning();
    const available = this.harness.maxConcurrentRuns - running;
    if (available <= 0) return;
    let started = 0;
    while (started < available) {
      const id = this.queued.values().next().value as string | undefined;
      if (!id) return;
      this.queued.delete(id);
      const session = this.sessions.get(id);
      if (
        !session ||
        session.view.status !== "queued" ||
        !session.queuedPrompt
      ) {
        continue;
      }
      const prompt = session.queuedPrompt;
      session.view = { ...session.view, status: "idle" };
      try {
        this.send(id, prompt);
        started++;
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
  }
  cancel(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Session not found.");
    if (session.view.status === "unknown" || session.recoveryBlock) return;
    if (session.view.status === "queued") {
      this.queued.delete(id);
      delete session.queuedPrompt;
      session.view = { ...session.view, status: "cancelled" };
      this.event(
        session,
        "tool",
        "Queued run stopped before dispatch.",
        { status: "cancelled" },
        "run.status",
      );
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
    let safeText =
      session.provider?.redact(JSON.stringify(payload)) ??
      JSON.stringify(payload);
    for (const config of Object.values(session.connections ?? {}))
      if (config.token)
        safeText = safeText.split(config.token).join("[redacted]");
    const safe = JSON.parse(safeText) as Record<string, unknown>;
    const appended: SessionEvent = {
      id: `${session.view.id}:${seq}`,
      sessionId: session.view.id,
      runId: session.view.runId,
      seq,
      at,
      kind,
      text: (session.provider?.redact(text) ?? text).slice(
        0,
        this.harness.maxPromptCharacters,
      ),
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
    };
    session.view = {
      ...session.view,
      updatedAt: at,
      events: trimViewEvents(session, [...session.view.events, appended]),
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
  /** The operator-tunable limits governing runs, as resolved on load. A copy,
   * so a caller cannot widen a limit by mutating the returned object. */
  harnessSettings(): HarnessSettings {
    return { ...this.harness };
  }
  patchHarnessSettings(body: Record<string, unknown>): HarnessSettings {
    // Validated before anything is stored: harnessSettingsPatch refuses an
    // unknown key by name and a non-numeric value rather than reporting a
    // change it did not make, and clamps what it accepts.
    this.harness = resolveHarnessSettings({
      ...this.harness,
      ...harnessSettingsPatch(body),
    });
    this.hasState = true;
    this.persist();
    return this.harnessSettings();
  }
  permissionModeState() {
    return this.permissionMode;
  }
  private assertNormalMutation(action: string) {
    if (this.permissionMode !== "normal")
      throw new Error(
        `Server permission mode ${this.permissionMode} forbids ${action}.`,
      );
  }
  private toolAllowedInMode(tool: McpTool) {
    return (
      this.permissionMode === "normal" ||
      (!tool.connectorId &&
        (tool.name === "void_workspace_list" ||
          tool.name === "void_workspace_read"))
    );
  }
  patchSession(id: string, body: Record<string, unknown>) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Session not found.");
    const patch = sessionPatch(body);
    session.view = {
      ...session.view,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
    return this.view(session);
  }
  sessionPage(query: URLSearchParams) {
    const all = filterRows(this.allViews(), query)
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
    return [...this.sessions.values()].map((session) => this.view(session));
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
    if (
      this.closing ||
      this.jobs.size ||
      session.recoveryBlock ||
      !["idle", "cancelled", "failed"].includes(session.view.status)
    )
      throw new Error(
        "Wait for the session to stop and settle. Reconcile unresolved recovery before changing documents.",
      );
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
  async spawnSubagent(
    parentId: string,
    prompt: string,
    options?: SpawnSubagentOptions,
  ): Promise<SessionView> {
    return this.locked(async () => {
      // ---- validate parent outcome (never spawn from an unresolved parent) ----
      const parent = this.sessions.get(parentId);
      if (!parent) throw new Error("Session not found.");
      const parentState = deriveRunState(
        parent.view.status,
        parent.view.events,
      );
      if (
        parentState === "unknown" ||
        parentState === "stopping" ||
        (parentState === "paused" &&
          (!parent.recoveryBlock ||
            parent.recoveryBlock.previousStatus === "unknown"))
      )
        throw new Error(
          "Parent session outcome is unresolved. Reconcile or settle it before spawning a subagent.",
        );
      if (parent.recoveryBlock)
        throw new Error(
          "Parent session outcome is unresolved. Reconcile or settle it before spawning a subagent.",
        );

      // ---- provider state ----
      if (!this.provider)
        throw new Error("Connect and validate a provider first.");
      if (this.providerSetupCount)
        throw new Error(
          "Wait for provider setup to finish before starting a session.",
        );

      // ---- closing / queue capacity (fail closed, before any wire) ----
      if (this.closing)
        throw new Error(
          "Wait for the active session or cancel it before starting another.",
        );
      if (this.queued.size >= this.harness.maxQueuedRuns)
        throw new Error(
          `Background queue is full (${this.harness.maxQueuedRuns} queued runs). Stop a queued run before adding another.`,
        );

      // ---- idempotency (foreign parent / different prompt both throw on digest mismatch) ----
      const idempotencyKey = validateIdempotencyKey(
        options?.idempotencyKey,
      );
      if (idempotencyKey) {
        const prior = this.request(idempotencyKey, [
          parentId,
          prompt,
        ]);
        if (prior) {
          const child = this.sessions.get(prior);
          if (!child)
            throw new Error("Idempotent spawn result is unavailable.");
          if (child.view.parentId !== parentId)
            throw new Error(
              "Idempotency key belongs to a subagent of a different session.",
            );
          return this.view(child);
        }
      }

      // ---- agent / model resolve ----
      const requestedAgent = options?.agent;
      let selectedAgent: (typeof AGENT_PRESETS)[number] | undefined;
      let selectedProfile: AgentProfile | undefined;
      if (requestedAgent) {
        selectedAgent = AGENT_PRESETS.find(
          (item) => item.id === requestedAgent,
        );
        selectedProfile = this.agentProfiles.find(
          (profile) => profile.id === requestedAgent,
        );
        if (!selectedAgent && !selectedProfile)
          throw new Error("Unknown agent preset or profile.");
      } else {
        selectedAgent = AGENT_PRESETS.find(
          (item) => item.id === parent.view.agent,
        );
        selectedProfile = parent.agentProfile
          ? structuredClone(parent.agentProfile)
          : undefined;
      }
      const selectedModel = options?.model ?? parent.view.model;
      if (
        !selectedModel ||
        !this.catalog.some((item) => item.id === selectedModel)
      )
        throw new Error("Select a model from the validated catalog.");

      // ---- prompt bounds ----
      const trimmedPrompt = validateSpawnPrompt(
        prompt,
        this.harness.maxPromptCharacters,
      );

      // ---- workspace command parse (same gate as start) ----
      const selectedGeneration = this.providerGeneration,
        selectedProvider = this.provider,
        selectedConfig = this.config;
      let command: unknown;
      try {
        command = JSON.parse(this.env.NOMO_UPSTREAM_COMMAND ?? "null");
      } catch {
        throw new Error("NOMO_UPSTREAM_COMMAND must be a JSON array.");
      }
      if (
        command !== null &&
        (!Array.isArray(command) ||
          !command.length ||
          !command.every(
            (item) => typeof item === "string" && item.length > 0,
          ))
      ) {
        throw new Error(
          "Configure NOMO_UPSTREAM_COMMAND on the runtime with the MCP server command as a JSON array.",
        );
      }
      if (command && !this.env.NOMO_POLICY_PATH)
        throw new Error(
          "Configure NOMO_POLICY_PATH before starting an agent.",
        );

      // ---- tool listing (mirror of startSession, without starting) ----
      const childId = randomUUID();
      const workspace = spawnWorkspaceName(childId);
      const client =
        Array.isArray(command)
          ? createNomoClient({
              workspace,
              ledgerDir:
                this.env.NOMO_LEDGER_DIR ??
                join(dataDir(homedir()), "ledger"),
              connect: { upstreamCommand: command },
              policyPath: this.env.NOMO_POLICY_PATH!,
              factsPath: this.env.NOMO_FACTS_PATH,
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
          connections[connector.id] = {
            ...connector,
            sessionId: listed.sessionId,
          };
          tools.push(
            ...listed.tools.map((tool) => ({
              ...tool,
              connectorId: connector.id,
            })),
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

      const systemInstruction = `You are operating through VOID. Tool calls are classified, governed by policy, and recorded. Respect denied calls; do not retry them with reworded arguments. Wait for operator approval of held calls. Only claim completed actions when they are proven by tool results. You have a managed document workspace with list, read, write and delete tools. Changes in that workspace are captured and can be undone by the operator. These tools do not access the host filesystem. Use them when asked to create or edit documents.${selectedAgent?.instruction ? `\n\nActive agent preset (${selectedAgent.id}): ${selectedAgent.instruction}` : ""}${selectedProfile ? `\n\nActive agent profile (${selectedProfile.id}): ${selectedProfile.systemPrompt}` : ""}`;

      // ---- effective tool list (mirrors startSession) then narrowed to parent ----
      const baseTools = (selectedProfile
        ? tools.filter((tool) =>
            selectedProfile.allowedTools.includes(tool.name),
          )
        : tools
      ).filter((tool) => this.toolAllowedInMode(tool));
      const finalTools = parent.tools
        ? subsetTools(baseTools, new Set(parent.tools.map((t) => t.name)))
        : baseTools;

      const queued =
        this.jobs.size > 0 ||
        this.countRunning() >= this.harness.maxConcurrentRuns;

      const session: Session = {
        view: {
          id: childId,
          workspace,
          model: selectedModel,
          provider: selectedConfig?.baseUrl,
          agent: selectedProfile?.id ?? selectedAgent?.id,
          createdAt: new Date().toISOString(),
          title: trimmedPrompt.slice(0, 80),
          status: queued ? "queued" : "idle",
          ...(queued ? { runId: randomUUID() } : {}),
          events: [],
          continuationCount: 0,
          runTokenCount: 0,
          parentId,
        },
        messages: [{ role: "system", content: systemInstruction }],
        agentProfile: selectedProfile
          ? structuredClone(selectedProfile)
          : undefined,
        queuedPrompt: queued ? trimmedPrompt : undefined,
        client,
        tools: finalTools,
        connections,
        config: selectedConfig
          ? { baseUrl: selectedConfig.baseUrl, kind: selectedConfig.kind }
          : undefined,
        controller: new AbortController(),
        provider: selectedProvider,
      };

      // ---- ledger-before-wire: commit on the parent chain first ----
      const promptDigest = `sha256:${await sha256Hex(trimmedPrompt)}`;
      try {
        await this.commitWorkspace(
          parent,
          this.documents[parent.view.workspace] ?? createWorkspace(),
          "void_subagent_spawn",
          { childId, parentId },
          "spawn:completed",
          undefined,
          undefined,
          {
            childId,
            parentId,
            childWorkspace: workspace,
            promptSha256: promptDigest,
            model: selectedModel,
            ...(selectedProfile?.id ?? selectedAgent?.id
              ? { agent: selectedProfile?.id ?? selectedAgent?.id }
              : {}),
          },
        );
      } catch (error) {
        client?.close();
        this.sessions.delete(childId);
        delete this.documents[workspace];
        this.queued.delete(childId);
        throw error instanceof Error
          ? new Error(
              `Failed to record the spawn entry: ${error.message}`,
            )
          : new Error("Failed to record the spawn entry.");
      }

      // ---- publish the session (after its spawn entry is signed) ----
      this.sessions.set(childId, session);
      this.documents[workspace] = createWorkspace();

      this.remember(idempotencyKey, [parentId, prompt], childId);

      if (queued) {
        this.queued.add(childId);
        this.event(session, "user", trimmedPrompt);
        this.event(
          session,
          "tool",
          "Queued",
          { status: "queued" },
          "run.status",
        );
        this.persist();
      } else {
        this.send(childId, trimmedPrompt);
      }
      return this.view(session);
    });
  }

  async branch(
    id: string,
    body: {
      seq: number;
      prompt?: string;
      snapshotDocuments?: boolean;
      idempotencyKey: string;
    },
  ) {
    return this.locked(async () => {
      if (
        typeof body.idempotencyKey !== "string" ||
        !/^[A-Za-z0-9_.:-]{1,160}$/.test(body.idempotencyKey)
      )
        throw new Error("Invalid Idempotency key.");
      const idempotencyKey = body.idempotencyKey;
      const requestValue = [
        id,
        body.seq,
        body.prompt,
        body.snapshotDocuments === true,
      ];
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
          (!parent.recoveryBlock ||
            parent.recoveryBlock.previousStatus === "unknown"))
      )
        throw new Error(
          "Parent session outcome is unresolved. Reconcile or settle it before branching.",
        );
      const messages = parent.view.events.filter(
        (e) =>
          e.seq <= body.seq &&
          ["user", "assistant"].includes(e.kind) &&
          (!e.type || e.type === "message.completed"),
      );
      if (body.prompt !== undefined) {
        if (
          !body.prompt.trim() ||
          body.prompt.length > this.harness.maxPromptCharacters ||
          messages.at(-1)?.kind !== "user"
        )
          throw new Error("Choose a user message to edit.");
        messages[messages.length - 1] = {
          ...messages.at(-1)!,
          text: body.prompt,
        };
      }

      // Every precondition above has passed, so a branch is about to happen and
      // only now is it safe to invalidate. This ran first, which meant a request
      // that was about to be refused -- a bad key, a message that does not
      // exist, an unsettled parent -- still dropped the armed trigger and any
      // retained review. An approval earned against this conversation was
      // destroyed by a request that never branched anything, and a round in
      // flight was told to discard a trajectory that was still the live one.
      //
      // Dropping the retained review rather than carrying it across is
      // deliberate: it was an approval of a trajectory that no longer exists,
      // and approving a different one by proxy is not a smaller mistake than
      // skipping the review entirely.
      const armed = this.harnessTriggers.get(id);
      if (armed !== undefined) this.harnessTriggers.set(id, onBranchMove(armed));

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
          name: "NOMO documents",
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
      this.connectors = before.map((item) => (item.id === id ? updated : item));
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
      this.connectors = before.map((item) => (item.id === id ? updated : item));
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
            ? (decision.rationale ?? "allowed by an allow rule")
            : decision.kind === "hold"
              ? (decision.rationale ?? `held for ${decision.seconds}s`)
              : decision.kind === "unmatched"
                ? "no rule matched; the policy file changed under this connector"
                : (decision.rationale ?? "denied by rule"),
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
    if (result.status === "unknown" || result.status === "dispatched")
      throw new UnknownToolOutcome();
    if (result.status !== "succeeded")
      throw new Error(
        `Managed document operation ${result.status}${result.reason ? ": " + result.reason : ""}. Reconcile its evidence before retrying.`,
      );
    return result.result;
  }
  private recoverySession(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Session not found.");
    if (
      this.closing ||
      this.jobs.size ||
      session.view.status === "running" ||
      session.view.status === "queued"
    )
      throw new Error("Wait for the agent to stop before recovery.");
    return session;
  }
  async planRecoveryJob(id: string, input: RecoveryRequest) {
    this.assertNormalMutation("recovery planning");
    return this.locked(async () => {
      const request = recoveryRequest(input),
        session = this.recoverySession(id);
      const runtime = await this.documentRuntime(session);
      const plan = await runtime.planRecoveryJob({
        workspace: session.view.workspace,
        jobId: request.jobId,
        selection: runtimeSelection(request.selection),
      });
      this.recoveryRequests[`${id}:${request.jobId}`] = request;
      this.persist();
      return recoveryPreview(
        plan,
        recoveryOperationMap(
          this.workspace(id).operations.map((op) => op.id),
          request.selection,
        ),
      );
    });
  }
  async recoveryJobStatus(id: string, jobId: string) {
    return this.locked(async () => {
      const session = this.sessions.get(id);
      if (!session) throw new Error("Session not found.");
      const request = this.recoveryRequests[`${id}:${jobId}`];
      if (!request) throw new Error("Recovery job not found.");
      const runtime = await this.documentRuntime(session);
      const status = await runtime.recoveryJobStatus(
        session.view.workspace,
        jobId,
      );
      const ids = recoveryOperationMap(
        this.workspace(id).operations.map((op) => op.id),
        request.selection,
      );
      return "digest" in status
        ? recoveryPreview(status, ids)
        : recoveryResult(status, ids);
    });
  }
  async applyRecoveryJob(
    id: string,
    input: RecoveryApply,
    operator: "web-operator" | "tui-operator" = "web-operator",
  ) {
    this.assertNormalMutation("recovery apply");
    return this.locked(async () => {
      const session = this.recoverySession(id);
      if (!input || input.approved !== true)
        throw new Error("Explicit operator approval is required.");
      const request = this.recoveryRequests[`${id}:${input.jobId}`];
      if (!request) throw new Error("Recovery job not found.");
      const runtime = await this.documentRuntime(session, { by: operator });
      // Reload the signed original plan even after a terminal result. A retry
      // cannot exchange its approval for another job or caller-supplied plan.
      const plan = await runtime.planRecoveryJob({
        workspace: session.view.workspace,
        jobId: request.jobId,
        selection: runtimeSelection(request.selection),
      });
      if (plan.digest !== input.planDigest)
        throw new Error("Recovery job digest changed. Refresh the preview.");
      this.recoverySession(id); // A synchronous send may have started while the signed plan loaded.
      const previousBlock = session.recoveryBlock;
      const block = previousBlock ?? {
        jobId: request.jobId,
        previousStatus: session.view.status,
      };
      session.recoveryBlock = block;
      session.view = {
        ...session.view,
        lastRecoveryJob: { jobId: request.jobId },
        status: block.previousStatus === "unknown" ? "unknown" : "paused",
      };
      this.persist(); // Persist the dispatch guard before any inverse can execute.
      try {
        const result = await runtime.runRecoveryJob(
          session.view.workspace,
          request.jobId,
          async (stored) => stored.digest === input.planDigest,
        );
        if (result.status === "unknown" || result.status === "paused") {
          session.view = {
            ...session.view,
            status:
              block.previousStatus === "unknown" ? "unknown" : result.status,
          };
        } else {
          session.view = { ...session.view, status: block.previousStatus };
          delete session.recoveryBlock;
        }
        this.persist();
        return recoveryResult(
          result,
          recoveryOperationMap(
            this.workspace(id).operations.map((op) => op.id),
            request.selection,
          ),
        );
      } catch (error) {
        // These runtime preflight refusals happen before the first inverse.
        // Every other thrown result remains uncertain until its job is reconciled.
        const refused =
          !previousBlock &&
          error instanceof Error &&
          [
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
      if (
        !preview.canApply &&
        !this.workspace(id).operations.some((op) => op.undoes === operationId)
      )
        throw new Error(preview.reason);
      const runtime = await this.documentRuntime(session, { by: operator }),
        runtimeId = digest(operationId);
      let status = await runtime.status(session.view.workspace, runtimeId);
      if (status === "unknown" || status === "dispatched")
        status = (await runtime.reconcile(session.view.workspace, runtimeId))
          .status;
      const plan =
        status === "succeeded"
          ? await runtime.planRecovery(session.view.workspace, runtimeId)
          : undefined;
      const prior = this.workspace(id);
      const transition = status
        ? undefined
        : applyWorkspaceUndo(prior, { id: `undo-${operationId}`, operationId });
      if (transition?.result.isError)
        throw new Error(transition.result.content[0]?.text ?? "Undo refused.");
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
            : await runtime.reconcileRecovery(
                session.view.workspace,
                runtimeId,
              );
          confirmed = result.status !== "unknown";
          if (result.status !== "restored")
            throw new Error(`Managed document recovery ${result.status}.`);
        } else {
          await this.commitWorkspace(
            session,
            transition!.state,
            "void_workspace_undo",
            { operationId },
            "execute:completed",
            transition!.operation,
          );
          confirmed = true;
        }
        this.event(session, "tool", `Undid ${operationId}.`);
        return { ok: true, workspace: this.workspace(id) };
      } finally {
        session.view = {
          ...session.view,
          status: confirmed ? previousStatus : "unknown",
        };
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
      // This is a read path. `devKeyProvider` creates a key when none exists,
      // so calling it here would mint signing capability as a side effect of
      // being asked to attest, the exact thing `retainedSigner` exists to
      // prevent, and the reason `ledger()` above goes through it. A workbench
      // that has never signed anything has nothing to attest with, and says so
      // instead of quietly acquiring the power to sign.
      const key = await this.retainedSigner();
      if (!key)
        throw new Error(
          "No verification key is available for the workspace ledger.",
        );
      return await attestLedger(dir, workspace, key);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  /**
   * Read explicit refinement entries from the verified workspace chain, along
   * with deterministic lessons mined from the same chain. This is descriptive
   * context only; policy and decision paths continue to mine rules separately.
   */
  async harnessEntries(workspace: string): Promise<HarnessEntry[]> {
    const proof = await this.ledger(workspace);
    const entries = proof?.entries ?? [];
    const latestBody = entries.at(-1)?.body as Record<string, unknown> | undefined;
    const generatedAt =
      typeof latestBody?.at === "string"
        ? latestBody.at
        : "1970-01-01T00:00:00.000Z";
    const mined = mineHarnessEntries(entries, { generatedAt }).entries;
    let overrides: HarnessEntry[] = [];
    let suppressedIds = new Set<string>();
    let approvedByOperator = false;
    for (let index = entries.length - 1; index >= 0; index--) {
      const body = entries[index]!.body as Record<string, unknown>;
      const refinement = body.harnessRefinement;
      if (refinement === null || typeof refinement !== "object") continue;
      const record = refinement as Record<string, unknown>;
      if (Array.isArray(record.overrides)) overrides = record.overrides as HarnessEntry[];
      if (Array.isArray(record.suppressedIds))
        suppressedIds = new Set(record.suppressedIds.filter((id): id is string => typeof id === "string"));
      approvedByOperator = record.approvedBy === "operator";
      break;
    }
    const byId = new Map<string, HarnessEntry>();
    for (const entry of mined)
      if (!suppressedIds.has(entry.id)) byId.set(entry.id, entry);
    // Only the approval path writes overrides, but the flag is gated on the
    // signed record rather than inferred from that: a future write that was
    // not an approval must not label mined text as an operator instruction.
    for (const entry of overrides)
      byId.set(entry.id, approvedByOperator ? { ...entry, decidedByOperator: true } : entry);
    return [...byId.values()];
  }

  /**
   * Record a validated refinement as an inert, signed workspace proposal.
   * Every supported edit waits for an operator decision. Skill and subagent
   * edits remain refused until their schema is supported.
   */
  async refineHarness(
    sessionId: string,
    input: RefinementProposal,
    options: { readonly expectedBranchVersion?: number } = {},
  ): Promise<{
    applied: readonly AppliedEdit[];
    awaitingApproval: readonly RefinementEdit[];
    proposalDigest?: string;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.view.id !== sessionId) throw new Error("Session not found.");
    this.assertNormalMutation("harness refinement");
    if (this.closing || session.recoveryBlock)
      throw new Error(
        "Wait for the workbench to reopen. Reconcile unresolved recovery before refining the harness.",
      );
    const validated = validateProposal(input);
    if (!validated.ok)
      throw new Error(`Invalid refinement proposal: ${validated.rejections.map((item) => item.reason).join("; ")}`);
    const proposal = validated.proposal;
    if (proposal.edits.some((edit) => edit.kind === "skill" || edit.kind === "subagent"))
      throw new Error("Skill and subagent edits are proposal-only until their schema is supported.");
    const knownSecrets = [
      ...Object.entries(this.env)
        .filter(
          ([name, value]) =>
            /secret|token|password|credential|api[_-]?key|private[_-]?key|authorization/i.test(name) && value,
        )
        .map(([, value]) => value!),
      this.config?.apiKey,
      this.workspaceKeySecret,
      ...Object.values(this.profiles).map((profile) => profile.apiKey),
      ...this.connectors.map((connector) => connector.token),
    ].filter((secret): secret is string => typeof secret === "string" && secret.length >= 4);
    if (refinementTextIsSensitive(proposal, knownSecrets))
      throw new Error("Refinement contains secret-like content and was not recorded.");
    if (proposal.edits.length === 0)
      return { applied: [], awaitingApproval: [] };

    const workspace = session.view.workspace;
    return this.locked(async () => {
      // branch() uses this same lock. Check after acquiring it, so a branch
      // queued ahead of this proposal makes the stale review fail closed.
      const currentBranchVersion = this.harnessTriggers.get(sessionId)?.branchVersion ?? 0;
      if (
        options.expectedBranchVersion !== undefined &&
        currentBranchVersion !== options.expectedBranchVersion
      )
        throw new Error("The branch moved while the Harness review was in flight.");
      const proof = await this.ledger(workspace);
      const verifiedSeqs = new Set((proof?.entries ?? []).map((entry) => entry.seq));
      for (const edit of proposal.edits)
        for (const seq of edit.derivedFromSeq)
          if (!verifiedSeqs.has(seq))
            throw new Error(`Refinement cites unverified workspace sequence ${seq}.`);

      const digest = await sha256Hex(canonicalJson(proposal));
      const state = this.documents[workspace] ?? createWorkspace();
      this.documents[workspace] ??= state;
      await this.commitWorkspace(
        session,
        state,
        "harness.proposal",
        { digest },
        "proposal:created",
        undefined,
        undefined,
        { harnessProposal: { digest, proposal } },
      );
      return {
        applied: [],
        awaitingApproval: proposal.edits,
        proposalDigest: digest,
      };
    });
  }

  private async pendingForWorkspace(
    entries: readonly JsonlEntry[],
  ): Promise<PendingApproval[]> {
    const pending = new Map<string, PendingApproval>();
    const verifiedSeqs = new Set(entries.map((entry) => entry.seq));
    for (const entry of entries) {
      const body = entry.body as Record<string, unknown>;
      const stored = body.harnessProposal;
      if (body.decision === "proposal:created" && stored !== null && typeof stored === "object") {
        const record = stored as Record<string, unknown>;
        const raw = record.proposal;
        const digest = record.digest;
        if (
          typeof digest === "string" &&
          /^[a-f0-9]{64}$/.test(digest) &&
          raw !== null &&
          typeof raw === "object" &&
          !Array.isArray(raw)
        ) {
          const proposal = raw as RefinementProposal;
          try {
            const validated = validateProposal(proposal);
            const actual = await sha256Hex(canonicalJson(proposal));
            if (
              validated.ok &&
              proposal.edits.length > 0 &&
              actual === digest &&
              proposal.edits.every((edit) => edit.derivedFromSeq.every((seq) => verifiedSeqs.has(seq)))
            ) {
              pending.set(digest, {
                proposal,
                digest,
                at: typeof body.at === "string" ? body.at : "",
                atSeq: entry.seq,
              });
            }
          } catch {
            continue;
          }
        }
      }
      const lifecycle = body.harnessLifecycle;
      const lifecycleRecord = lifecycle !== null && typeof lifecycle === "object"
        ? lifecycle as Record<string, unknown>
        : undefined;
      const refinement = body.harnessRefinement;
      const refinementRecord = refinement !== null && typeof refinement === "object"
        ? refinement as Record<string, unknown>
        : undefined;
      const storedRecord = stored !== null && typeof stored === "object"
        ? stored as Record<string, unknown>
        : undefined;
      const terminalDigest =
        (typeof storedRecord?.digest === "string" && storedRecord.digest) ||
        (typeof lifecycleRecord?.digest === "string" && lifecycleRecord.digest) ||
        (typeof refinementRecord?.digest === "string" && refinementRecord.digest);
      if (
        terminalDigest &&
        ["proposal:activated", "proposal:rejected", "refinement:approved"].includes(String(body.decision))
      )
        pending.delete(terminalDigest);
    }
    return [...pending.values()].sort((a, b) => a.atSeq - b.atSeq || a.digest.localeCompare(b.digest));
  }

  async pendingApprovalsFor(sessionId: string): Promise<readonly PendingHarnessProposal[]> {
    const session = this.sessions.get(sessionId);
    if (!session || session.view.id !== sessionId) return [];
    const proof = await this.ledger(session.view.workspace);
    if (!proof) return [];
    return (await this.pendingForWorkspace(proof.entries)).map((pending) => ({
      digest: pending.digest,
      at: pending.at,
      atSeq: pending.atSeq,
      summary: pending.proposal.summary,
      proposal: structuredClone(pending.proposal),
      addendum: pending.proposal.edits
        .filter((edit) => edit.kind === "prompt")
        .map((edit) => edit.promptAddendum ?? "")
        .join("\n"),
    }));
  }

  async approveHarnessProposal(
    sessionId: string,
    digest: string,
  ): Promise<{ applied: readonly AppliedEdit[] }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.view.id !== sessionId) throw new Error("Session not found.");
    this.assertNormalMutation("harness refinement");
    if (this.closing || session.recoveryBlock)
      throw new Error(
        "Wait for the workbench to reopen. Reconcile unresolved recovery before refining the harness.",
      );
    const workspace = session.view.workspace;
    return this.locked(async () => {
      const proof = await this.ledger(workspace);
      if (!proof) throw new Error("No pending refinement matches that digest.");
      const pending = (await this.pendingForWorkspace(proof.entries))
        .find((proposal) => proposal.digest === digest);
      if (!pending) throw new Error("No pending refinement matches that digest.");
      if (proof.entries.length !== pending.atSeq)
        throw new Error(
          "The chain moved after the proposal was reviewed. Ask for a new proposal.",
        );
      const generatedAt = new Date().toISOString();
      const current = await this.harnessEntries(workspace);
      const result = applyProposal(
        current,
        pending.proposal,
        generatedAt,
        { by: "operator", digest, atSeq: pending.atSeq },
      );
      if (!result.applied.length)
        throw new Error("The approved proposal has no supported edit to activate.");
      const { overrides, suppressedIds } = this.refinementDelta(
        workspace,
        result.entries,
        generatedAt,
      );
      const state = this.documents[workspace] ?? createWorkspace();
      this.documents[workspace] ??= state;
      const tombstones = result.applied
        .filter((edit) => edit.outcome === "deleted")
        .map((edit) => edit.edit.id)
        .filter((id): id is string => typeof id === "string");
      const supersessions = result.applied
        .filter((edit) => edit.outcome === "superseded")
        .map((edit) => edit.edit.id)
        .filter((id): id is string => typeof id === "string");
      await this.commitWorkspace(
        session,
        state,
        "harness.activation",
        { digest },
        "proposal:activated",
        undefined,
        { by: "operator" },
        {
          harnessProposal: { digest, status: "approved", proposal: pending.proposal },
          harnessLifecycle: {
            digest,
            events: [
              "proposal:approved",
              "proposal:activated",
              ...(tombstones.length ? ["entry:tombstone"] : []),
              ...(supersessions.length ? ["entry:supersession"] : []),
            ],
            tombstones,
            supersessions,
            atSeq: pending.atSeq,
          },
          harnessRefinement: {
            summary: pending.proposal.summary,
            rationale: pending.proposal.rationale,
            expectedOutcome: pending.proposal.expectedOutcome,
            applied: result.applied,
            overrides,
            suppressedIds,
            approvedBy: "operator",
            digest,
            atSeq: pending.atSeq,
          },
        },
      );
      return { applied: result.applied };
    });
  }

  async rejectHarnessProposal(
    sessionId: string,
    digest: string,
    reason = "",
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.view.id !== sessionId) throw new Error("Session not found.");
    this.assertNormalMutation("harness refinement");
    if (this.closing || session.recoveryBlock)
      throw new Error(
        "Wait for the workbench to reopen. Reconcile unresolved recovery before refining the harness.",
      );
    const workspace = session.view.workspace;
    return this.locked(async () => {
      const proof = await this.ledger(workspace);
      if (!proof) throw new Error("No pending refinement matches that digest.");
      const pending = (await this.pendingForWorkspace(proof.entries))
        .find((proposal) => proposal.digest === digest);
      if (!pending) throw new Error("No pending refinement matches that digest.");
      const state = this.documents[workspace] ?? createWorkspace();
      this.documents[workspace] ??= state;
      await this.commitWorkspace(
        session,
        state,
        "harness.rejection",
        { digest, reason },
        "proposal:rejected",
        undefined,
        undefined,
        { harnessProposal: { digest, status: "rejected" } },
      );
    });
  }

  /**
   * Issues a short-lived local proxy capability from the stored run and tool
   * snapshot. Caller supplied workspace, agent and run IDs are not accepted.
   */
  issueLocalAgentGrant(
    sessionId: string,
    upstreamId: string,
  ): IssuedLocalAgentGrant {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session not found.");
    if (session.view.status !== "running" || !session.view.runId)
      throw new Error("A local agent grant requires an active run.");
    if (session.proxyGrantReadyRunId !== session.view.runId)
      throw new Error("The run has not passed its before-run gate.");
    if (!session.view.agent)
      throw new Error("The active run has no registered agent identity.");
    const toolScope = (session.tools ?? [])
      .filter((tool) => tool.connectorId === upstreamId)
      .map((tool) => tool.name);
    if (!toolScope.length)
      throw new Error("The upstream is not configured for this run.");
    return this.localIdentityIssuer.issue({
      principalId: LOCAL_AGENT_PRINCIPAL_ID,
      workspaceId: session.view.workspace,
      agentId: session.view.agent,
      runId: session.view.runId,
      upstreamId,
      toolScope,
    });
  }
  /** Validate a grant against the proxy audience, upstream and requested tool. */
  validateLocalAgentGrant(
    token: string,
    request: Pick<LocalAgentGrantRequest, "upstreamId" | "toolName">,
  ): LocalAgentIdentity | null {
    if (!request) return null;
    return this.localIdentityIssuer.validate(token, {
      audience: LOCAL_AGENT_GRANT_AUDIENCE,
      upstreamId: request.upstreamId,
      toolName: request.toolName,
    });
  }
  /** Resolve a grant for the local proxy without authorizing a specific tool. */
  resolveLocalAgentGrant(
    token: string,
    upstreamId: string,
  ): LocalAgentIdentity | null {
    return this.localIdentityIssuer.authenticate(token, {
      audience: LOCAL_AGENT_GRANT_AUDIENCE,
      upstreamId,
    });
  }
  /**
   * The local key storage answer, without reaching the provider: asking the
   * provider to answer a question about local storage is a network call that
   * can fail for reasons that have nothing to do with it.
   */
  keyStorageState(): string {
    return this.keyStorage;
  }

  async applyPromptAddendum(
    sessionId: string,
    digest: string,
  ): Promise<{ applied: readonly AppliedEdit[] }> {
    const pending = (await this.pendingApprovalsFor(sessionId))
      .find((proposal) => proposal.digest === digest);
    if (!pending) throw new Error("No pending refinement matches that digest.");
    if (!pending.proposal.edits.every((edit) => edit.kind === "prompt"))
      throw new Error("Use harness proposal approval for edits beyond prompt addenda.");
    return this.approveHarnessProposal(sessionId, digest);
  }

  /**
   * What a refinement record has to carry for the entry set to rebuild.
   *
   * One helper rather than two copies of the same filter: the applied path and
   * the approval path both write a record that `harnessEntries` reads back, and
   * a record that differs between them silently resurrects a deleted mined
   * entry or freezes a mined lesson's repeat count.
   *
   * `createdAt` is stamped when an entry is mined, so two honest runs over the
   * same chain never agree on it. Comparing it would mark every mined lesson as
   * edited and store it as an override, and an override outranks the chain on
   * every later read: the count would freeze at the value it had when the
   * refinement happened.
   */
  private refinementDelta(
    workspace: string,
    entries: readonly HarnessEntry[],
    generatedAt: string,
  ): { overrides: HarnessEntry[]; suppressedIds: string[] } {
    const mined = mineHarnessEntries(this.evidence[workspace] ?? [], { generatedAt })
      .entries;
    const minedById = new Map(mined.map((entry) => [entry.id, entry]));
    const resultIds = new Set(entries.map((entry) => entry.id));
    const comparable = (entry: HarnessEntry) => {
      const { createdAt: _stamped, ...rest } = entry;
      return canonicalJson(rest);
    };
    return {
      overrides: entries.filter((entry) => {
        const original = minedById.get(entry.id);
        return original === undefined || comparable(original) !== comparable(entry);
      }),
      suppressedIds: mined
        .filter((entry) => !resultIds.has(entry.id))
        .map((entry) => entry.id),
    };
  }

  async ledger(workspace: string) {
    if (!Object.hasOwn(this.documents, workspace)) return undefined;
    const entries = this.evidence[workspace] ?? [],
      key = await this.verificationKey(() => this.retainedSigner());
    const result = await verifyChain(entries, { publicKey: key.publicKey });
    if (!result.ok)
      throw new Error("Workspace ledger signature verification failed.");
    return { entries: structuredClone(entries), result, verification: key };
  }
  /**
   * Service one settled turn at the harness boundary.
   *
   * Runs after the turn's own result is final and recorded, so a slow review
   * never changes what the turn already reported and never leaves the session
   * looking stuck. Every step is the runtime's: the gate refuses without a
   * provider request, and a proposal that does not validate never reaches the
   * chain.
   *
   * A failure here is reported and forgotten rather than propagated. The turn
   * it follows succeeded, and a learning pass that failed is not a reason to
   * mark a successful turn as failed.
   */
  private async serviceHarnessTurn(session: Session, surface: GateSurface): Promise<void> {
    if (!session.provider) return;
    const id = session.view.id;
    const previous = this.harnessTriggers.get(id) ?? initialTriggerState();
    const state = recordSettledTurn(previous);
    this.harnessTriggers.set(id, state);
    try {
      await this.runHarnessBoundary(session, state, surface);
    } catch (error) {
      this.reportHarnessFailure(session, error);
    }
  }
  /**
   * Request a harness review by hand, as `/harness review` does.
   *
   * Served immediately when the conversation is idle, recorded for the next
   * settled boundary when it is not. A held gate refusal (under cooldown,
   * nothing new, in flight) also reports `armed`: the trigger keeps the
   * request and a later boundary will serve it, so calling that a refusal
   * would tell the operator to ask again for something already queued.
   *
   * A request that arrives while a round is already running joins that round:
   * the running review is the answer to the same intent, and a second round
   * would spend a second model call on it.
   */
  async requestHarnessReview(id: string): Promise<ManualReviewResult> {
    const session = this.sessions.get(id);
    if (!session) return { kind: "refused", note: "Session not found." };
    // A round already running answers this request too: joining it spends
    // nothing and cannot double-write, because the joiner only reads the
    // outcome. Without this, two requests race the gate and pay twice.
    const inFlight = this.harnessBoundariesInFlight.get(id);
    if (inFlight) {
      try {
        return this.manualResultFrom(await inFlight.run, inFlight.lenses);
      } catch (error) {
        // The running round's own caller reports the failure; the joiner
        // reports the outcome it received and reports nothing itself.
        return {
          kind: "failed",
          note: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (
      this.jobs.has(id) ||
      session.view.status === "running" ||
      session.view.status === "queued"
    ) {
      this.harnessTriggers.set(
        id,
        requestManualReview(this.harnessTriggers.get(id) ?? initialTriggerState()),
      );
      const note =
        "The conversation is running; the request is served at the next settled boundary.";
      this.event(
        session,
        "tool",
        note,
        { outcome: "armed" },
        "harness.review.requested",
      );
      return { kind: "armed", note };
    }
    // Checked before the flag is set: a refusal for a missing provider must
    // not leave the request armed, or a later settled turn would spend a
    // model call on a request the operator was told was refused.
    if (!session.provider)
      return {
        kind: "refused",
        note: "Connect the provider before requesting a harness review.",
      };
    const state = requestManualReview(
      this.harnessTriggers.get(id) ?? initialTriggerState(),
    );
    // The map holds the request cleared while this call serves it, so a
    // settled turn counted during the round cannot re-arm a request the
    // round is already answering. A held refusal puts the flag back through
    // the boundary's write-back, so nothing that was kept is lost.
    this.harnessTriggers.set(id, { ...state, manualReviewRequested: false });
    // An aborted controller belongs to a cancelled or closed run. The manual
    // review is its own action, so it does not inherit that cancellation.
    if (session.controller.signal.aborted)
      session.controller = new AbortController();
    try {
      const { result, lenses } = await this.runHarnessBoundary(session, state, "checkpoint");
      return this.manualResultFrom(result, lenses);
    } catch (error) {
      this.reportHarnessFailure(session, error);
      return {
        kind: "failed",
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }
  /** The operator-facing sentence for one boundary outcome. */
  private manualResultFrom(result: ServiceResult, lenses: number): ManualReviewResult {
    switch (result.outcome.kind) {
      case "ran":
        // The same sentence the event log carries: both surfaces name the
        // same count.
        return { kind: "ran", note: reviewRanNote(lenses) };
      case "declined":
        return { kind: "declined", note: result.outcome.reason };
      case "failed":
        return {
          kind: "failed",
          note:
            result.outcome.error instanceof Error
              ? result.outcome.error.message
              : String(result.outcome.error),
        };
      case "not-run":
        // A held refusal kept the request for a later boundary; a cleared
        // one means the gate answered that it cannot be served at all.
        return result.state.manualReviewRequested
          ? { kind: "armed", note: result.outcome.reason }
          : { kind: "refused", note: result.outcome.reason };
    }
  }
  /**
   * One boundary call, shared by the settled turn and the manual request.
   *
   * The caller owns the state it passes in: the turn path has already counted
   * its settled turn, and a manual request deliberately has not, because no
   * turn settled to pay for it. The branch-version write-back guard lives in
   * the body rather than at the call sites so both paths keep it.
   *
   * One boundary runs per session at a time. A second caller receives the
   * running round's result rather than starting another: two concurrent
   * rounds would spend two model calls on one intent and could write the
   * same evidence twice.
   */
  private async runHarnessBoundary(
    session: Session,
    state: TriggerState,
    surface: GateSurface,
  ): Promise<{ readonly result: ServiceResult; readonly lenses: number }> {
    const id = session.view.id;
    const inFlight = this.harnessBoundariesInFlight.get(id);
    if (inFlight) return { result: await inFlight.run, lenses: inFlight.lenses };
    // Captured before the round awaits: every note about this round must name
    // the count it actually paid for, not whatever the operator patches in
    // while it runs.
    const lenses = resolveLensCount(this.harness.refinementLensCount);
    const run = this.serveHarnessBoundary(session, state, surface, lenses);
    const entry = { run, lenses };
    this.harnessBoundariesInFlight.set(id, entry);
    try {
      return { result: await run, lenses };
    } finally {
      this.harnessBoundariesInFlight.delete(id);
    }
  }
  /** The boundary itself: gate, review, apply, write-back, report. */
  private async serveHarnessBoundary(
    session: Session,
    state: TriggerState,
    surface: GateSurface,
    lenses: number,
  ): Promise<ServiceResult> {
    const provider = session.provider;
    if (!provider)
      throw new Error("Connect the provider before requesting a harness review.");
    const id = session.view.id;
    const result = await serviceHarnessBoundary(state, {
      // The gate decides when the harness spends a model call, so an operator
      // has to be able to move it. It was passed DEFAULT_REFINE_GATES
      // directly, which left resolveRefineGates reachable only from tests.
      gates: resolveRefineGates({
        enabled: this.harness.refinementEnabled === 1,
        turnInterval: this.harness.refinementTurnInterval,
        cooldownMs: this.harness.refinementCooldownMs,
      }),
      surface,
      now: () => Date.now(),
      entries: async () => await this.harnessEntries(session.view.workspace),
      // The operator's prompt ceiling governs this request like any other.
      // It did not before: the user-prompt path enforces maxPromptCharacters
      // in three places and this one read the setting for nothing.
      maxPromptCharacters: this.harness.maxPromptCharacters,
      // The count captured for this round before it awaited: the same value
      // every note about the round names.
      reviewLensCount: lenses,
      // The refusals currently mined from this workspace's own chain. The
      // reviewer is told how many, not what: the gate already decided the
      // round is worth paying for, and handing over the full rule list would
      // answer a question the chain does not support.
      rules: () => mineLearnedRules(this.evidence[session.view.workspace] ?? []).length,
      ask: async (request) => {
        const reply = await provider.complete(
          session.view.model,
          [{ role: "user", content: request }],
          [],
          session.controller.signal,
        );
        // The review is a model call like any other and costs money like any
        // other. The turn path records reply.usage; this one used to throw it
        // away, so an operator reading usage saw conversation turns only and
        // the harness spent on its own account without appearing anywhere.
        if (reply.usage)
          this.event(
            session,
            "usage",
            `${reply.usage.total_tokens ?? "Unknown"} tokens reported by the harness reviewer`,
            {
              ...reply.usage,
              model: session.view.model,
              source: "harness",
              cost: null,
            },
          );
        return reply.message.content ?? "";
      },
      apply: async (proposal, expectedBranchVersion) => {
        await this.refineHarness(id, proposal, { expectedBranchVersion });
      },
      currentBranchVersion: () =>
        this.harnessTriggers.get(id)?.branchVersion ?? state.branchVersion,
    });
    // A branch move may update the map while the review awaits. Do not overwrite its newer version.
    const currentVersion = this.harnessTriggers.get(id)?.branchVersion ?? state.branchVersion;
    const expectedVersion = result.startedAtBranchVersion ?? state.branchVersion;
    if (currentVersion === expectedVersion) {
      const live = this.harnessTriggers.get(id);
      // A caller that replaced the map entry while this round ran (a settled
      // turn counted, a manual arm recorded) must not lose what it recorded.
      // The turn count is added rather than maxed: a completed review resets
      // the result to zero and the turns that settled during the round still
      // belong to the next window.
      const merged =
        live !== undefined && live !== state
          ? {
              ...result.state,
              manualReviewRequested:
                result.state.manualReviewRequested || live.manualReviewRequested,
              settledTurnsSinceReview:
                result.state.settledTurnsSinceReview +
                Math.max(0, live.settledTurnsSinceReview - state.settledTurnsSinceReview),
            }
          : result.state;
      this.harnessTriggers.set(id, merged);
    }
    this.reportHarnessOutcome(session, result, lenses);
    return result;
  }
  /**
   * The one line a boundary leaves behind.
   *
   * The boundary is silent by default, and silence here is ambiguous: an
   * operator watching a workspace learn nothing cannot tell a gate that
   * refused from a hook that was never reached. One line naming the outcome
   * costs nothing when there is no work to do and settles the question when
   * there is.
   */
  private reportHarnessOutcome(
    session: Session,
    result: ServiceResult,
    lenses: number,
  ): void {
    const note =
      result.outcome.kind === "not-run"
        ? result.outcome.reason
        : result.outcome.kind === "declined"
          ? `Review declined: ${result.outcome.reason}`
          : result.outcome.kind === "ran"
            ? reviewRanNote(lenses)
            : null;
    if (note !== null)
      this.event(
        session,
        "tool",
        note,
        { outcome: result.outcome.kind },
        "harness.review",
      );
  }
  private reportHarnessFailure(session: Session, error: unknown): void {
    this.event(
      session,
      "tool",
      `Harness review did not complete: ${error instanceof Error ? error.message : String(error)}`,
      { status: session.view.status },
      "harness.review.failed",
    );
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
      throw new Error(
        "No verification key is available for the workspace ledger.",
      );
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
      // A workspace that had no committed state before this call must not be
      // left registered with an empty state just because the write failed: the
      // phantom key would make `ledger()` return a verified-but-empty chain
      // and hide the failure from the next read.
      if (before === undefined) delete this.documents[workspace];
      else this.documents[workspace] = before;
      this.evidence[workspace] = current;
      throw error;
    }
  }
  private async syncStdio(session: Session) {
    return this.locked(async () => {
      const path = join(
        this.env.NOMO_LEDGER_DIR ?? join(dataDir(homedir()), "ledger"),
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
      // `devKeyProvider()` at its default `~/.void/keys`, *not* with the
      // workbench's own document key under the data directory. Resolving
      // against the wrong directory finds nothing, and the throw below turns
      // that into an unknown tool outcome for a tool that ran perfectly well.
      // The public key still comes from the shared resolution, so an operator's
      // out-of-band pin wins and the fallback is reported as degraded.
      // The proxy's key directory is overridable so a test can isolate from the
      // operator's real `~/.void/keys`; unset, it is exactly what it always
      // was. It is deliberately NOT `this.storage.directory`: that is the
      // document key, and resolving against it would find nothing.
      const proxyKeys =
        this.env.NOMO_PROXY_KEYS ?? join(dataDir(homedir()), "keys");
      const key = await this.verificationKey(() =>
        this.retainedSigner(proxyKeys),
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
  /**
   * The policy a call is decided under: the operator's own rules first, then
   * whatever has been mined from this workspace's signed chain.
   *
   * Learned rules go last on purpose. `decide` takes the first matching rule,
   * so anything placed earlier could let a pattern a model happened to repeat
   * override a decision an operator made deliberately. A learned rule is
   * evidence, not authority, it may only fill a gap the operator left open.
   *
   * The rules are not written back: this is derived on read, so a chain that
   * is truncated or rolled back cannot leave a stale rule in force.
   */
  private policyWithLearned(
    policy: ValidPolicy,
    workspace: string,
  ): ValidPolicy {
    const learned = mineLearnedRules(this.evidence[workspace] ?? []);
    if (learned.length === 0) return policy;
    return {
      ok: true,
      policy: { ...policy.policy, rules: [...policy.policy.rules, ...learned] },
    };
  }

  private async authorizeTool(
    session: Session,
    call: {
      tool: string;
      workspace: string;
      connector: string;
      klass: string;
      blastRadius: number | undefined;
      reason: string;
      arguments: JsonObject;
    },
    decision: PolicyDecision | { kind: "deny" },
    policy: ValidPolicy,
  ) {
    const name = call.tool,
      args = call.arguments;
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
      if (allowed) {
        // Track continuations: each hold approval is one continuation.
        // The run loop will stop if the limit is reached.
        session.view = {
          ...session.view,
          continuationCount: session.view.continuationCount + 1,
        };
      }
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
  /**
   * Run one tool call and fire `after-tool`.
   *
   * The wrapper exists so every path reports: the inner `executeTool` returns
   * from a dozen places and throws from several more, and a hook that only
   * fires on the happy path is a hook that silently stops describing what the
   * agent did. `observed` is filled in by the inner method as the decision is
   * made, then read here after the outcome is known.
   */
  private async execute(
    session: Session,
    tool: McpTool,
    args: JsonObject,
    id: string,
  ): Promise<unknown> {
    const observed: { decision: string; outcome: string } = {
      decision: "undecided",
      outcome: "unknown",
    };
    let result: unknown;
    try {
      result = await this.executeTool(session, tool, args, id, observed);
      observed.outcome = (result as { isError?: boolean } | undefined)?.isError
        ? "refused"
        : "completed";
      return result;
    } catch (error) {
      observed.outcome =
        error instanceof UnknownToolOutcome ? "unknown" : "failed";
      throw error;
    } finally {
      // The tool has already run; a hook failure here reports and changes
      // nothing, so it is never allowed to mask the tool's own outcome.
      await this.fireHooks(
        "after-tool",
        {
          tool: tool.name,
          decision: observed.decision,
          outcome: observed.outcome,
          callId: id,
          workspace: session.view.workspace,
          runId: session.view.runId,
        },
        session,
      );
    }
  }
  private async executeTool(
    session: Session,
    tool: McpTool,
    args: JsonObject,
    id: string,
    observed: { decision: string; outcome: string },
  ): Promise<unknown> {
    if (!this.toolAllowedInMode(tool)) {
      observed.decision = `mode:${this.permissionMode}`;
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Server permission mode ${this.permissionMode} forbids ${tool.name}.`,
          },
        ],
      };
    }
    if (session.agentProfile) {
      // The profile's policyProfile names the policy its tool calls are
      // decided under. An unresolvable name refuses here rather than
      // falling through to the built-in policy, so a profile can never widen
      // itself by naming something that does not resolve.
      const profile = resolvePolicyProfile(
        session.agentProfile.policyProfile,
        this.env.NOMO_POLICY_PATH,
      );
      if (!profile.ok)
        throw new Error(
          `Agent policy profile ${session.agentProfile.policyProfile} is unusable. ${profile.reason}.`,
        );
      if (!session.agentProfile.allowedTools.includes(tool.name))
        throw new Error(
          "Agent policy refused a tool outside its allowed scope.",
        );
      if (!tool.connectorId) {
        const call = {
          tool: tool.name,
          workspace: session.view.workspace,
          connector: "workspace",
          klass: workspaceToolClass(tool.name) ?? "r3",
          blastRadius: 1,
          reason: "Managed document policy.",
          arguments: args,
        };
        const policy = this.policyWithLearned(
          profile.policy,
          session.view.workspace,
        );
        const decision = decide(policy, call);
        const allowed = await this.authorizeTool(
          session,
          call,
          decision,
          policy,
        );
        observed.decision =
          decision.kind === "hold"
            ? allowed
              ? "hold:approved"
              : "hold:denied"
            : decision.kind;
        if (!allowed)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: denialText(tool.name, call.klass, decision),
              },
            ],
          };
      }
    }
    if (tool.connectorId === "stdio") {
      // The stdio proxy decides upstream and reports its own decision in the
      // ledger; this side records that it delegated rather than inventing one.
      observed.decision = "proxy";
      if (!session.client)
        throw new Error("This stdio connection ended. Start a new session.");
      const before = this.evidence[session.view.workspace]?.length ?? 0;
      let outcome: { result: unknown } | { error: unknown };
      try {
        outcome = {
          result: await session.client.request("tools/call", {
            name: tool.name,
            arguments: args,
          }),
        };
      } catch (error) {
        outcome = { error };
      }
      try {
        await this.syncStdio(session);
      } catch {
        throw new UnknownToolOutcome();
      }
      if ("result" in outcome) return outcome.result;
      // A typed denial alone can be forged by an upstream. Require fresh,
      // verified proxy evidence for this exact tool and argument digest.
      // Bare hex, and canonical rather than `JSON.stringify`: this has to match
      // the digest the proxy recorded on its own entry, not ours. `syncStdio`
      // commits those with empty `args` and the proxy's digest spread in as
      // metadata, which lands after `argsDigest` in the body literal and
      // replaces it. `legacyArgsDigest` in the proxy package writes exactly
      // this spelling; the two must not drift, and the prefix our own writer
      // uses would never match it. Key order is what silently broke it.
      const argsDigest = await sha256Hex(canonicalJson(args));
      const receipt = this.evidence[session.view.workspace]
        ?.slice(before)
        .map((entry) => entry.body as Record<string, unknown>)
        .filter(
          (body) =>
            body.source === "stdio-proxy" &&
            body.tool === tool.name &&
            body.argsDigest === argsDigest,
        )
        .at(-1);
      if (
        outcome.error instanceof HoldDeniedError &&
        (receipt?.decision === "hold:denied" ||
          receipt?.decision === "hold:expired")
      ) {
        return {
          isError: true,
          content: [{ type: "text", text: outcome.error.message }],
        };
      }
      throw new UnknownToolOutcome();
    }
    if (!tool.connectorId) {
      observed.decision = "managed-document";
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
    }
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
    // Decided under the raw operator policy by design: learned rules are
    // deliberately not merged here. The loader requires the terminal catch-all
    // (match: {}) as the last rule and decide is first-match-wins, so any rule
    // appended after it, which is where policyWithLearned puts mined rules, is
    // structurally unreachable. Merging here would suggest learned rules bind
    // connector calls when they cannot, and evidence stays evidence.
    const policy = loadPolicy(config.policy ?? DEFAULT_POLICY);
    if (!policy.ok) throw new Error("Invalid policy.");
    const decision =
      classification.outcome === "classified"
        ? decide(policy, call)
        : { kind: "deny" as const };
    const allowed = await this.authorizeTool(session, call, decision, policy);
    observed.decision =
      decision.kind === "hold"
        ? allowed
          ? "hold:approved"
          : "hold:denied"
        : decision.kind;
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
      result = await rpc(
        config,
        "tools/call",
        { name: tool.name, arguments: args },
        config.sessionId,
      );
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
          this.sessionAttribution(session, policy, decision),
        ),
      );
    } catch {
      try {
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
            this.sessionAttribution(session, policy, decision),
          ),
        );
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
      retryAt:
        error instanceof ProviderRequestError && error.retryAfter !== undefined
          ? new Date(Date.now() + error.retryAfter * 1000).toISOString()
          : null,
    };
  }
  private checkContextBudget(
    session: Session,
    tools: readonly unknown[],
    outputTokens = 4096,
  ) {
    if (!session.agentProfile) return;
    // UTF-8 bytes plus protocol overhead are a conservative token bound, not
    // a fabricated tokenizer measurement. Reserve the provider's fixed output
    // ceiling too; an oversized combined context never dispatches.
    const bound =
      Buffer.byteLength(JSON.stringify(session.messages)) +
      Buffer.byteLength(JSON.stringify(tools)) +
      1024 +
      outputTokens;
    if (bound > session.agentProfile.maxContextTokens)
      throw new Error(
        "Agent context budget reached. Increase the budget or compact before continuing.",
      );
  }
  private async run(session: Session): Promise<void> {
    const provider = session.provider;
    // A run that outruns its ceiling is stopped here rather than left to the
    // provider's own per-request timeout, which bounds one request and not the
    // run. The deadline rides alongside the cancel signal so a cancel still
    // cancels, and an expired deadline is reported as its own condition
    // instead of as the generic abort the transport raises.
    const runTimeoutMs = this.harness.maxRunTimeoutMs;
    const deadline = AbortSignal.timeout(runTimeoutMs);
    const signal = AbortSignal.any([session.controller.signal, deadline]);
    const expired = () =>
      deadline.aborted && !session.controller.signal.aborted;
    // Declared outside the try so the finally below can always take the block
    // back out, whichever way the run ends.
    let digestMarker: ModelMessage | undefined;
    try {
      if (!provider)
        throw new Error(
          "Reconnect the provider used by this conversation before continuing.",
        );
      if (session.agentProfile) {
        session.agentProfile = validateAgentProfile(session.agentProfile);
        // Resolved once per turn so a profile whose policy file disappeared
        // after it was saved fails the turn instead of quietly running under a
        // policy its operator never chose.
        const policy = resolvePolicyProfile(
          session.agentProfile.policyProfile,
          this.env.NOMO_POLICY_PATH,
        );
        if (!policy.ok)
          throw new Error(`Unknown agent policy profile: ${policy.reason}.`);
      }
      // before-run gates the turn. A refusal is thrown into the same handler
      // as every other run failure, so the session ends "failed" with the hook
      // named, it never reaches the provider and is never recorded as a pass.
      const gate = await this.fireHooks(
        "before-run",
        {
          sessionId: session.view.id,
          workspace: session.view.workspace,
          runId: session.view.runId,
          model: session.view.model,
        },
        session,
      );
      const refused = gate.find((result) => !hookSucceeded(result));
      if (refused)
        throw new Error(
          `Hook ${refused.hookId} refused this run: ${refused.outcome}${refused.code === null ? "" : ` (exit ${refused.code})`}.${refused.stderr ? ` ${refused.stderr}` : ""}`,
        );
      session.proxyGrantReadyRunId = session.view.runId;
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
      // An agent profile's own maxTurns still wins: it was validated against
      // AGENT_LIMITS.maxTurns when the profile was accepted, so it is a limit
      // somebody chose for that session. The harness setting is the fallback
      // for a run with no profile, which is the case an operator is tuning.
      const maxTurns = session.agentProfile?.maxTurns ?? this.harness.maxTurns;
      // Retrieved context rides follow-up turns only, never the turn that mined
      // it: mining runs at the settled boundary after dispatch, so a first turn
      // has nothing to retrieve by construction. Ephemeral: pushed for this
      // run's provider calls and removed in the finally below, so the stored
      // conversation never carries a digest block. A stale block, left by a
      // crash between push and removal, is swept first for the same reason.
      session.messages = session.messages.filter(
        (message) =>
          message.role !== "system" ||
          typeof message.content !== "string" ||
          !message.content.startsWith("NOMO learned-entry digest,"),
      );
      if (session.messages.length > 2) {
        const latestUser = [...session.messages]
          .reverse()
          .find((message) => message.role === "user");
        const block = retrievalContext(
          await this.harnessEntries(session.view.workspace),
          String(latestUser?.content ?? ""),
          this.harness,
        );
        if (block !== "") {
          digestMarker = { role: "system", content: block };
          session.messages.push(digestMarker);
        }
      }
      // The digest is a chain over the turns, not a snapshot of the newest
      // ones. Folding the previous turn's digest in keeps the cost at O(turn)
      // while making the earlier prefix reach the current value: two
      // conversations that arrive at the same tail through different histories
      // now differ, because the turn where they parted changed every digest
      // after it. The previous derivation hashed only the messages added since
      // the last turn, plus a bare count, and its comment claimed the prefix
      // was "already inside the previous digest's input" when nothing read the
      // previous value at all.
      let previous: string | null = null;
      let hashed = 0;
      for (let turn = 0; turn < maxTurns; turn++) {
        if (expired()) throw new RunTimeout(runTimeoutMs);
        if (session.controller.signal.aborted) return;
        if (session.view.continuationCount >= this.harness.maxContinuations) {
          session.view = { ...session.view, status: "idle" };
          this.event(
            session,
            "tool",
            `Continuation limit reached (${this.harness.maxContinuations}). Review the ledger before continuing.`,
            { status: "idle" },
            "run.status",
          );
          this.persist();
          return;
        }
        const maxRunTokens = this.harness.maxRunTokens;
        if (maxRunTokens > 0 && session.view.runTokenCount >= maxRunTokens) {
          session.view = { ...session.view, status: "idle" };
          this.event(
            session,
            "tool",
            `Run token budget reached (${maxRunTokens}). Review the ledger before continuing.`,
            { status: "idle" },
            "run.status",
          );
          this.persist();
          return;
        }
        this.checkContextBudget(session, tools);
        // The record a tool call produces has to name what asked for it, and
        // the conversation is the only part of that which is not derivable
        // from the record itself. One digest for the turn, not one per tool
        // call: every record the turn produces names the same request, and a
        // per-call digest would hash the same growing conversation repeatedly.
        session.requestDigest = await conversationRequestDigest(
          previous,
          session.view.model,
          session.messages.slice(hashed),
          tools,
        );
        previous = session.requestDigest;
        hashed = session.messages.length;
        if (session.messages.length >= 200)
          throw new Error(
            "Session context limit reached. Start a new session.",
          );
        let delta = "";
        let flushed = Date.now();
        const reply = await Promise.race([
          provider.complete(
            session.view.model,
            session.messages,
            tools,
            signal,
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
          ),
          // Raced rather than relied on through the signal alone: a transport
          // that never settles would otherwise keep the run alive past its
          // ceiling, and the ceiling would only ever be checked between turns.
          new Promise<never>((_, refuse) => {
            if (deadline.aborted) refuse(new RunTimeout(runTimeoutMs));
            else
              deadline.addEventListener("abort", () => {
                refuse(new RunTimeout(runTimeoutMs));
              });
          }),
        ]);
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
        if (reply.usage?.total_tokens) {
          session.view = {
            ...session.view,
            runTokenCount:
              session.view.runTokenCount + reply.usage.total_tokens,
          };
        }
        if (
          (reply.message.tool_calls?.length ?? 0) >
          this.harness.maxToolCallsPerTurn
        )
          throw new Error(
            `Provider exceeded the ${this.harness.maxToolCallsPerTurn}-tool batch limit.`,
          );
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
            session,
            tool!,
            args as JsonObject,
            `${session.view.runId}-${turn}-${callIndex}`,
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
            content: provider.redact(JSON.stringify(result)).slice(0, 64000),
          });
        }
      }
      throw new Error(
        `Session reached the ${maxTurns}-turn limit. Review the ledger before continuing.`,
      );
    } catch (error) {
      // An expired deadline names itself. A transport that ignored the abort
      // raises a plain AbortError, which says nothing about why the run stopped,
      // so the cause is recovered here instead of surfacing as "failed".
      const cause = expired() ? new RunTimeout(runTimeoutMs) : error;
      if (
        !session.controller.signal.aborted ||
        cause instanceof UnknownToolOutcome ||
        cause instanceof RunTimeout
      ) {
        if (cause instanceof ProviderRequestError && provider === this.provider)
          this.recordProviderFailure(cause);
        const failure =
          cause instanceof ProviderRequestError
            ? providerFailure(cause)
            : undefined;
        this.event(
          session,
          "error",
          failure?.text ??
            (cause instanceof Error ? cause.message : "Session failed."),
          failure?.payload ?? {},
        );
        // A timed-out run is `unknown`, not `failed`: nothing proved what it
        // did, so a retry would be a guess over an unproven outcome. This is the
        // state Undo and reconciliation both require.
        session.view = {
          ...session.view,
          status:
            cause instanceof UnknownToolOutcome || cause instanceof RunTimeout
              ? "unknown"
              : "failed",
        };
        session.client?.close();
      }
    } finally {
      // The retrieval block was only ever provider input for this run. Take it
      // back out first, so neither the stored conversation nor a later digest
      // over these messages carries a copy of it.
      // Two independent teardown steps in the same finally block, both needed
      // whichever way the run ended. A run that failed still held a capability
      // this process issued to itself; leaving it alive after the run would let
      // a later call reuse it.
      if (session.view.runId)
        this.localIdentityIssuer.revoke(session.view.runId);
      session.proxyGrantReadyRunId = undefined;
      // The retrieval block was only ever provider input for this run. Take it
      // back out first, so neither the stored conversation nor a later digest
      // over these messages carries a copy of it.
      if (digestMarker !== undefined) {
        const at = session.messages.indexOf(digestMarker);
        if (at >= 0) session.messages.splice(at, 1);
      }
      // after-run observes, so it never changes the status it reports: the
      // view is already final here and a failing observer only reports.
      await this.fireHooks(
        "after-run",
        {
          sessionId: session.view.id,
          workspace: session.view.workspace,
          runId: session.view.runId,
          outcome: session.view.status,
        },
        session,
      );
      this.event(
        session,
        "tool",
        session.view.status,
        { status: session.view.status },
        "run.status",
      );
      this.persist();
      // A settled turn is the only boundary at which the harness may spend a
      // model call on learning, and it is serviced after the turn's own result
      // is final so the review cannot rewrite what already happened. A turn
      // that failed is not settled: there is nothing to learn from an outcome
      // nobody knows.
      if (session.view.status === "idle") {
        const pass = this.serviceHarnessTurn(session, "checkpoint").catch(() => {});
        this.harnessJobs.add(pass);
        void pass.finally(() => this.harnessJobs.delete(pass));
      }
    }
  }
}

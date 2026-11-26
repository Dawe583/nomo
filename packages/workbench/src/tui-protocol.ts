import type { SessionEvent, SessionView } from "./index.ts";

export const TUI_PROTOCOL_VERSION = 1;
export const TUI_TRANSCRIPT_PAGE_DEFAULT_LIMIT = 100;
export const TUI_TRANSCRIPT_PAGE_MAX_LIMIT = 500;
export const TUI_DEFAULT_PROMPT_MAX_CHARACTERS = 32000;

export const TUI_VIEWS = [
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
export type TuiViewName = (typeof TUI_VIEWS)[number];

export type TuiTerminalCapabilities = {
  readonly columns: number;
  readonly rows: number;
  readonly ansi: boolean;
  readonly colorDepth: 0 | 4 | 8 | 24;
  readonly cellHeightPixels?: number;
  readonly graphicsProtocol?: "kitty";
  readonly symbolPreset: "ascii" | "unicode" | "nerd";
  readonly motion: "full" | "reduced" | "off";
};

/** Static session metadata. Transcript text and payloads are deliberately not
 * part of this object; they belong to the paged transcript channel. */
export type TuiSessionSummary = {
  readonly id: string;
  readonly workspace: string;
  readonly model: string;
  readonly title?: string;
  readonly status: SessionView["status"];
  readonly state?: SessionView["state"];
  readonly provider?: string;
  readonly runId?: string;
  readonly parentId?: string;
  readonly project?: string;
  readonly agent?: string;
  readonly contextMessages?: number;
  readonly continuationCount: number;
  readonly runTokenCount: number;
};

export type TuiTranscriptEvent = Pick<
  SessionEvent,
  | "seq"
  | "at"
  | "kind"
  | "text"
  | "id"
  | "sessionId"
  | "runId"
  | "type"
  | "payload"
  | "schemaVersion"
>;

export type TuiTranscriptPage = {
  readonly sessionId: string;
  readonly events: readonly TuiTranscriptEvent[];
  readonly latestSeq: number;
  readonly oldestSeq: number;
  readonly hasMore: boolean;
  readonly nextBeforeSeq: number | null;
};

export type TuiUsageStatus = {
  readonly contextMessages: number;
  readonly runTokenCount: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cost?: number;
};

export type TuiApprovalSummary = {
  readonly holdId: string;
  readonly sessionId?: string;
  readonly tool: string;
  readonly reversibilityClass?: string;
  readonly status: "pending" | "approved" | "denied" | "expired" | "interrupted";
  readonly expiresAt?: number;
};

const TUI_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "interrupted",
] as const;

export type TuiApprovalInput = {
  readonly holdId: string;
  readonly sessionId?: string;
  readonly status: string;
  readonly expiresAt?: number;
  readonly call?: {
    readonly tool?: unknown;
    readonly class?: unknown;
    readonly klass?: unknown;
  };
};

/** Normalize a workbench or proxy hold without hiding a malformed one. An
 * unknown tool is printed as unknown; an impossible hold status is rejected
 * because the frontend cannot safely render a decision state it does not know. */
export function tuiApprovalSummary(hold: TuiApprovalInput): TuiApprovalSummary {
  const status = TUI_APPROVAL_STATUSES.find(
    (candidate) => candidate === hold.status,
  );
  if (!status) throw new Error(`Invalid TUI approval status: ${hold.status}`);
  const rawTool = hold.call?.tool;
  const rawClass = hold.call?.class ?? hold.call?.klass;
  return {
    holdId: hold.holdId,
    ...(hold.sessionId === undefined ? {} : { sessionId: hold.sessionId }),
    tool:
      typeof rawTool === "string" && rawTool.trim() ? rawTool.trim() : "unknown",
    ...(typeof rawClass === "string" && rawClass.trim()
      ? { reversibilityClass: rawClass.trim() }
      : {}),
    status,
    ...(hold.expiresAt === undefined ? {} : { expiresAt: hold.expiresAt }),
  };
}

export type TuiProviderStatus = {
  readonly providerId?: string;
  readonly status: "ready" | "setup-required" | "rate-limited" | "unavailable";
  readonly model?: string;
  readonly detail?: string;
};

export type TuiPaletteCommand = {
  readonly command: string;
  readonly description: string;
};

export type TuiClientContext = {
  readonly activeView: TuiViewName;
  readonly terminal: TuiTerminalCapabilities;
};

/** Server-owned workbench state. Active panel and terminal capabilities are
 * deliberately absent: they are client-owned render context, not workbench
 * state a server should mirror or persist. */
export type TuiSnapshot = {
  readonly version: typeof TUI_PROTOCOL_VERSION;
  readonly session?: TuiSessionSummary;
  readonly sessions: readonly TuiSessionSummary[];
  readonly transcript?: TuiTranscriptPage;
  readonly approvals: readonly TuiApprovalSummary[];
  readonly provider: TuiProviderStatus;
  readonly usage?: TuiUsageStatus;
  readonly palette: readonly TuiPaletteCommand[];
  readonly diagnostics: readonly string[];
};

export type TuiRenderState = {
  readonly version: typeof TUI_PROTOCOL_VERSION;
  readonly client: TuiClientContext;
  readonly workbench: TuiSnapshot;
};

export type TuiProtocolError = {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
};

export type TuiServerEvent =
  | { readonly type: "snapshot"; readonly snapshot: TuiSnapshot }
  | {
      readonly type: "transcript.appended";
      readonly sessionId: string;
      readonly event: TuiTranscriptEvent;
    }
  | { readonly type: "session.updated"; readonly session: TuiSessionSummary }
  | { readonly type: "approval.changed"; readonly approval: TuiApprovalSummary }
  | { readonly type: "provider.changed"; readonly provider: TuiProviderStatus }
  | {
      readonly type: "intent.accepted";
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "intent.rejected";
      readonly idempotencyKey?: string;
      readonly error: TuiProtocolError;
    }
  | { readonly type: "diagnostic"; readonly message: string };

export type TuiProtocolMessage = {
  readonly version: typeof TUI_PROTOCOL_VERSION;
  readonly event: TuiServerEvent;
};

export type TuiIntent =
  | {
      readonly type: "session.create";
      readonly prompt: string;
      readonly model?: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "prompt.submit";
      readonly sessionId: string;
      readonly prompt: string;
      readonly idempotencyKey: string;
    }
  | { readonly type: "run.stop"; readonly sessionId: string }
  | {
      readonly type: "approval.decide";
      readonly holdId: string;
      readonly decision: "approved" | "denied";
      readonly by: string;
      readonly reason?: string;
    }
  | { readonly type: "palette.execute"; readonly command: string }
  | { readonly type: "view.select"; readonly view: TuiViewName };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new Error(`Invalid TUI intent: ${message}`);
}

function text(
  value: unknown,
  field: string,
  max: number,
  options: { readonly trim?: boolean; readonly pattern?: RegExp } = {},
): string {
  if (typeof value !== "string") invalid(`${field} must be a string`);
  const result = options.trim === false ? value : value.trim();
  if (!result.trim()) invalid(`${field} must not be empty`);
  if (result.length > max) invalid(`${field} exceeds ${max} characters`);
  if (options.pattern && !options.pattern.test(result))
    invalid(`${field} has an invalid shape`);
  return result;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, field, max);
}

function idempotencyKey(value: unknown): string {
  return text(value, "idempotencyKey", 128, {
    pattern: /^[A-Za-z0-9:_-]{8,128}$/,
  });
}

/** Validate an operator intent crossing the terminal boundary. Unknown fields
 * are ignored so a newer client can extend the contract without breaking an
 * older host; required fields never become optional implicitly. */
export function parseTuiIntent(
  value: unknown,
  options: { readonly maxPromptCharacters?: number } = {},
): TuiIntent {
  if (!isRecord(value) || typeof value.type !== "string")
    invalid("type is required");
  const promptMax = options.maxPromptCharacters ?? TUI_DEFAULT_PROMPT_MAX_CHARACTERS;
  if (value.type === "session.create") {
    return {
      type: "session.create",
      prompt: text(value.prompt, "prompt", promptMax, { trim: false }),
      ...(optionalText(value.model, "model", 200) === undefined
        ? {}
        : { model: optionalText(value.model, "model", 200) }),
      idempotencyKey: idempotencyKey(value.idempotencyKey),
    };
  }
  if (value.type === "prompt.submit") {
    return {
      type: "prompt.submit",
      sessionId: text(value.sessionId, "sessionId", 160),
      prompt: text(value.prompt, "prompt", promptMax, { trim: false }),
      idempotencyKey: idempotencyKey(value.idempotencyKey),
    };
  }
  if (value.type === "run.stop") {
    return {
      type: "run.stop",
      sessionId: text(value.sessionId, "sessionId", 160),
    };
  }
  if (value.type === "approval.decide") {
    const decision = value.decision;
    if (decision !== "approved" && decision !== "denied")
      invalid("decision must be approved or denied");
    return {
      type: "approval.decide",
      holdId: text(value.holdId, "holdId", 256),
      decision,
      by: text(value.by, "by", 120),
      ...(optionalText(value.reason, "reason", 500) === undefined
        ? {}
        : { reason: optionalText(value.reason, "reason", 500) }),
    };
  }
  if (value.type === "palette.execute") {
    return {
      type: "palette.execute",
      command: text(value.command, "command", 200, {
        pattern: /^\/\S(?:[^\n\r]*)$/,
      }),
    };
  }
  if (value.type === "view.select") {
    const view = TUI_VIEWS.find((candidate) => candidate === value.view);
    if (!view) invalid("view is not a protocol view");
    return { type: "view.select", view };
  }
  invalid(`unknown type ${value.type}`);
}

export function tuiSessionSummary(view: SessionView): TuiSessionSummary {
  return {
    id: view.id,
    workspace: view.workspace,
    model: view.model,
    ...(view.title === undefined ? {} : { title: view.title }),
    status: view.status,
    ...(view.state === undefined ? {} : { state: view.state }),
    ...(view.provider === undefined ? {} : { provider: view.provider }),
    ...(view.runId === undefined ? {} : { runId: view.runId }),
    ...(view.parentId === undefined ? {} : { parentId: view.parentId }),
    ...(view.project === undefined ? {} : { project: view.project }),
    ...(view.agent === undefined ? {} : { agent: view.agent }),
    ...(view.contextMessages === undefined
      ? {}
      : { contextMessages: view.contextMessages }),
    continuationCount: view.continuationCount,
    runTokenCount: view.runTokenCount,
  };
}

function transcriptEvent(event: SessionEvent): TuiTranscriptEvent {
  return {
    seq: event.seq,
    at: event.at,
    kind: event.kind,
    text: event.text,
    ...(event.id === undefined ? {} : { id: event.id }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    ...(event.type === undefined ? {} : { type: event.type }),
    ...(event.payload === undefined
      ? {}
      : { payload: structuredClone(event.payload) }),
    ...(event.schemaVersion === undefined
      ? {}
      : { schemaVersion: event.schemaVersion }),
  };
}

/** Return the newest page older than `beforeSeq`, ordered ascending. The first
 * page uses the live tail, so a terminal can start at the bottom and page back
 * without loading the whole retained transcript. */
export function tuiTranscriptPage(
  view: SessionView,
  input: { readonly beforeSeq?: number; readonly limit?: number } = {},
): TuiTranscriptPage {
  const limit = input.limit ?? TUI_TRANSCRIPT_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > TUI_TRANSCRIPT_PAGE_MAX_LIMIT)
    throw new Error(
      `TUI transcript limit must be an integer between 1 and ${TUI_TRANSCRIPT_PAGE_MAX_LIMIT}.`,
    );
  if (
    input.beforeSeq !== undefined &&
    (!Number.isInteger(input.beforeSeq) || input.beforeSeq < 1)
  )
    throw new Error("TUI transcript beforeSeq must be a positive integer.");
  const beforeSeq = input.beforeSeq;
  const source =
    beforeSeq === undefined
      ? view.events
      : view.events.filter((event) => event.seq < beforeSeq);
  const page = source.slice(-limit);
  const first = page[0];
  return {
    sessionId: view.id,
    events: page.map(transcriptEvent),
    latestSeq: view.events.at(-1)?.seq ?? 0,
    oldestSeq: view.events[0]?.seq ?? 0,
    hasMore: first !== undefined && view.events[0]?.seq !== first.seq,
    nextBeforeSeq:
      first !== undefined && view.events[0]?.seq !== first.seq ? first.seq : null,
  };
}

function usageNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function tuiUsageStatus(view: SessionView): TuiUsageStatus {
  const usage = [...view.events].reverse().find((event) => event.kind === "usage")
    ?.payload;
  return {
    contextMessages: view.contextMessages ?? 0,
    runTokenCount: view.runTokenCount,
    ...(usage && usageNumber(usage, "prompt_tokens") !== undefined
      ? { promptTokens: usageNumber(usage, "prompt_tokens") }
      : {}),
    ...(usage && usageNumber(usage, "completion_tokens") !== undefined
      ? { completionTokens: usageNumber(usage, "completion_tokens") }
      : {}),
    ...(usage && usageNumber(usage, "total_tokens") !== undefined
      ? { totalTokens: usageNumber(usage, "total_tokens") }
      : {}),
    ...(usage && usageNumber(usage, "cost") !== undefined
      ? { cost: usageNumber(usage, "cost") }
      : {}),
  };
}

export function tuiSnapshot(input: {
  readonly session?: SessionView;
  readonly sessions?: readonly SessionView[];
  readonly approvals?: readonly TuiApprovalSummary[];
  readonly provider: TuiProviderStatus;
  readonly palette?: readonly TuiPaletteCommand[];
  readonly diagnostics?: readonly string[];
  readonly transcriptLimit?: number;
  readonly transcriptBeforeSeq?: number;
}): TuiSnapshot {
  const sessions = input.sessions ?? (input.session ? [input.session] : []);
  return {
    version: TUI_PROTOCOL_VERSION,
    ...(input.session === undefined
      ? {}
      : { session: tuiSessionSummary(input.session) }),
    sessions: sessions.map(tuiSessionSummary),
    ...(input.session === undefined
      ? {}
      : {
          transcript: tuiTranscriptPage(input.session, {
            ...(input.transcriptBeforeSeq === undefined
              ? {}
              : { beforeSeq: input.transcriptBeforeSeq }),
            ...(input.transcriptLimit === undefined
              ? {}
              : { limit: input.transcriptLimit }),
          }),
          usage: tuiUsageStatus(input.session),
        }),
    approvals: input.approvals ?? [],
    provider: input.provider,
    palette: input.palette ?? [],
    diagnostics: input.diagnostics ?? [],
  };
}

/** Adapt the read-only workbench projection into the wire snapshot without
 * probing providers or letting the client choose server state. The active
 * session is explicit because panel focus is client-owned render context. */
export function tuiSnapshotFromWorkbench(
  source: {
    readonly allViews: () => readonly SessionView[];
    readonly approvals: () => readonly TuiApprovalInput[];
  },
  input: {
    readonly sessionId?: string;
    readonly provider: TuiProviderStatus;
    readonly palette?: readonly TuiPaletteCommand[];
    readonly diagnostics?: readonly string[];
    readonly transcriptLimit?: number;
    readonly transcriptBeforeSeq?: number;
  },
): TuiSnapshot {
  const sessions = source.allViews();
  const session =
    input.sessionId === undefined
      ? undefined
      : sessions.find((candidate) => candidate.id === input.sessionId);
  if (input.sessionId !== undefined && session === undefined)
    throw new Error(`Unknown TUI snapshot session: ${input.sessionId}`);
  return tuiSnapshot({
    ...(session === undefined ? {} : { session }),
    sessions,
    approvals: source.approvals().map(tuiApprovalSummary),
    provider: input.provider,
    ...(input.palette === undefined ? {} : { palette: input.palette }),
    ...(input.diagnostics === undefined
      ? {}
      : { diagnostics: input.diagnostics }),
    ...(input.transcriptLimit === undefined
      ? {}
      : { transcriptLimit: input.transcriptLimit }),
    ...(input.transcriptBeforeSeq === undefined
      ? {}
      : { transcriptBeforeSeq: input.transcriptBeforeSeq }),
  });
}

export function tuiRenderState(input: {
  readonly client: TuiClientContext;
  readonly workbench: TuiSnapshot;
}): TuiRenderState {
  return {
    version: TUI_PROTOCOL_VERSION,
    client: input.client,
    workbench: input.workbench,
  };
}

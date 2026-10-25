import { Buffer } from "node:buffer";

export const AGENT_RUNNER_OUTPUT_LIMITS = {
  maxMessageBytes: 16 * 1024,
  maxRunBytes: 64 * 1024,
} as const;

export const AGENT_RUNNER_EVENT_LIMITS = {
  maxEvents: 100_000,
  maxEventBytes: 64 * 1024,
  maxRunIdBytes: 256,
} as const;

export type AgentRunnerContractErrorCode =
  | "unknown-profile"
  | "invalid-description"
  | "invalid-run-id"
  | "event-after-terminal"
  | "event-limit"
  | "terminal-missing"
  | "invalid-event"
  | "run-id-mismatch"
  | "sequence-mismatch"
  | "event-too-large"
  | "tool-request-duplicate"
  | "tool-result-unmatched"
  | "tool-response-too-large";

export class AgentRunnerContractError extends Error {
  readonly code: AgentRunnerContractErrorCode;
  constructor(code: AgentRunnerContractErrorCode) {
    super(code);
    this.code = code;
    this.name = "AgentRunnerContractError";
  }
}

/** Adapter claims are descriptive only; Workbench must enforce them before start. */
export type AgentRunnerDescription = {
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
  readonly endpoint: string;
  readonly dataTransfer: "local-only" | "remote";
  readonly dataSent: readonly ("task" | "system-prompt" | "tool-arguments" | "tool-results")[];
  readonly profiles: readonly string[];
  readonly execution: "local" | "remote";
  readonly toolAccess: "mediated" | "unmediated";
  readonly workspaceMode: "approved-copy" | "opaque";
  readonly cancellation: "confirmed" | "may-be-unknown";
};

export type AgentWorkspaceGrant = {
  readonly id: string;
  readonly rootDigest: `sha256:${string}`;
  readonly allowedTools: readonly string[];
};

export type AgentToolDefinition = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
};

export type AgentRunInput = {
  readonly task: string;
  readonly systemPrompt: string;
  readonly workspace: AgentWorkspaceGrant;
  readonly profileId?: string;
  readonly tools: readonly AgentToolDefinition[];
  readonly signal: AbortSignal;
};

export type AgentRunEvent =
  | {
      readonly type: "status";
      readonly runId: string;
      readonly sequence: number;
      readonly status: "starting" | "running";
      readonly message?: string;
    }
  | {
      readonly type: "tool-request";
      readonly runId: string;
      readonly sequence: number;
      readonly requestId: string;
      readonly toolName: string;
      readonly argsJson: string;
    }
  | {
      readonly type: "tool-result";
      readonly runId: string;
      readonly sequence: number;
      readonly requestId: string;
      readonly resultJson: string;
    }
  | {
      readonly type: "assistant-message";
      readonly runId: string;
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly type: "terminal";
      readonly runId: string;
      readonly sequence: number;
      readonly status: "completed" | "failed" | "cancelled" | "unknown";
      readonly message?: string;
    };

export type AgentRunToolResponse =
  | { readonly kind: "result"; readonly resultJson: string }
  | { readonly kind: "error"; readonly message: string };

export type AgentRun = {
  readonly id: string;
  readonly events: AsyncIterable<AgentRunEvent>;
  /** Resolve one pending request; the runner must not continue before this. */
  respondToTool(requestId: string, response: AgentRunToolResponse): Promise<void>;
};

export type AgentCancelResult = "confirmed" | "unknown";

export interface AgentRunner {
  describe(): AgentRunnerDescription;
  start(input: AgentRunInput): Promise<AgentRun>;
  cancel(runId: string): Promise<AgentCancelResult>;
}

export function assertKnownAgentRunnerProfile(
  description: AgentRunnerDescription,
  profileId?: string,
): void {
  if (profileId !== undefined && !description.profiles.includes(profileId))
    throw new AgentRunnerContractError("unknown-profile");
}

export function assertSafeAgentRunnerDescription(
  raw: unknown,
): asserts raw is AgentRunnerDescription {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new AgentRunnerContractError("invalid-description");
  const description = raw as Record<string, unknown>;
  const allowed = [
    "id", "displayName", "provider", "endpoint", "dataTransfer", "dataSent",
    "profiles", "execution", "toolAccess", "workspaceMode", "cancellation",
  ];
  if (
    !onlyKeys(description, allowed) ||
    !isBoundedText(description.id, 256) ||
    !isBoundedText(description.displayName, 256) ||
    !isBoundedText(description.endpoint, 2048) ||
    !isBoundedText(description.provider, 256) ||
    !Array.isArray(description.dataSent) ||
    description.dataSent.length > 4 ||
    !description.dataSent.every((item) =>
      ["task", "system-prompt", "tool-arguments", "tool-results"].includes(item as string)
    ) ||
    new Set(description.dataSent).size !== description.dataSent.length ||
    !Array.isArray(description.profiles) ||
    description.profiles.length > 64 ||
    !description.profiles.every((profile) => isBoundedText(profile, 256)) ||
    new Set(description.profiles).size !== description.profiles.length ||
    (description.execution !== "local" && description.execution !== "remote") ||
    (description.toolAccess !== "mediated" &&
      description.toolAccess !== "unmediated") ||
    (description.workspaceMode !== "approved-copy" &&
      description.workspaceMode !== "opaque") ||
    (description.cancellation !== "confirmed" &&
      description.cancellation !== "may-be-unknown") ||
    (description.dataTransfer !== "local-only" &&
      description.dataTransfer !== "remote")
  ) throw new AgentRunnerContractError("invalid-description");
  if (
    (description.dataTransfer === "remote" && description.dataSent.length === 0) ||
    (description.dataTransfer === "local-only" && description.dataSent.length > 0)
  ) throw new AgentRunnerContractError("invalid-description");

  if (description.dataTransfer === "remote") {
    let endpoint: URL;
    try {
      endpoint = new URL(description.endpoint);
    } catch {
      throw new AgentRunnerContractError("invalid-description");
    }
    const loopback =
      endpoint.hostname === "localhost" ||
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]";
    if (
      (endpoint.protocol !== "https:" &&
        !(endpoint.protocol === "http:" && loopback)) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) throw new AgentRunnerContractError("invalid-description");
  } else if (description.execution !== "local") {
    throw new AgentRunnerContractError("invalid-description");
  }
  if (description.toolAccess !== "mediated" ||
      description.workspaceMode !== "approved-copy")
    throw new AgentRunnerContractError("invalid-description");
}

export async function* validateAgentRunEvents(
  runId: string,
  events: AsyncIterable<unknown>,
): AsyncGenerator<AgentRunEvent> {
  if (!isBoundedText(runId, AGENT_RUNNER_EVENT_LIMITS.maxRunIdBytes))
    throw new AgentRunnerContractError("invalid-run-id");

  let expectedSequence = 1;
  let terminal = false;
  for await (const raw of events) {
    if (terminal) throw new AgentRunnerContractError("event-after-terminal");
    if (expectedSequence > AGENT_RUNNER_EVENT_LIMITS.maxEvents)
      throw new AgentRunnerContractError("event-limit");

    const event = validateEvent(raw, runId, expectedSequence);
    expectedSequence++;
    terminal = event.type === "terminal";
    yield event;
  }

  if (!terminal) throw new AgentRunnerContractError("terminal-missing");
}

/**
 * The only tool-dispatch path for event-driven adapters. Each request receives
 * one mediated response before the stream can proceed to its result event.
 */
export async function mediateAgentRunEvents(
  run: AgentRun,
  executeTool: (
    request: Extract<AgentRunEvent, { type: "tool-request" }>,
  ) => Promise<AgentRunToolResponse>,
  onEvent: (event: AgentRunEvent) => void | Promise<void> = () => {},
): Promise<void> {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for await (const event of validateAgentRunEvents(run.id, run.events)) {
    if (event.type === "tool-request") {
      if (seen.has(event.requestId))
        throw new AgentRunnerContractError("tool-request-duplicate");
      seen.add(event.requestId);
      pending.add(event.requestId);
      const response = await executeTool(event);
      if (
        (response.kind === "result" &&
          !isBoundedText(response.resultJson, AGENT_RUNNER_EVENT_LIMITS.maxEventBytes)) ||
        (response.kind === "error" &&
          !isBoundedText(response.message, 4096))
      ) throw new AgentRunnerContractError("tool-response-too-large");
      await run.respondToTool(event.requestId, response);
      continue;
    }
    if (event.type === "tool-result" && !pending.delete(event.requestId))
      throw new AgentRunnerContractError("tool-result-unmatched");
    await onEvent(event);
  }
  if (pending.size) throw new AgentRunnerContractError("tool-result-unmatched");
}

function validateEvent(
  raw: unknown,
  runId: string,
  expectedSequence: number,
): AgentRunEvent {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new AgentRunnerContractError("invalid-event");
  const event = raw as Record<string, unknown>;
  if (event.runId !== runId) throw new AgentRunnerContractError("run-id-mismatch");
  if (event.sequence !== expectedSequence)
    throw new AgentRunnerContractError("sequence-mismatch");

  switch (event.type) {
    case "status":
      if (
        (event.status !== "starting" && event.status !== "running") ||
        !onlyKeys(event, ["type", "runId", "sequence", "status", "message"]) ||
        (event.message !== undefined && !isBoundedText(event.message, 4096))
      ) throw new AgentRunnerContractError("invalid-event");
      break;
    case "tool-request":
      if (
        !onlyKeys(event, ["type", "runId", "sequence", "requestId", "toolName", "argsJson"]) ||
        !isBoundedText(event.requestId, 256) ||
        !isBoundedText(event.toolName, 256) ||
        !isBoundedText(event.argsJson, AGENT_RUNNER_EVENT_LIMITS.maxEventBytes)
      ) throw new AgentRunnerContractError("invalid-event");
      break;
    case "tool-result":
      if (
        !onlyKeys(event, ["type", "runId", "sequence", "requestId", "resultJson"]) ||
        !isBoundedText(event.requestId, 256) ||
        !isBoundedText(event.resultJson, AGENT_RUNNER_EVENT_LIMITS.maxEventBytes)
      ) throw new AgentRunnerContractError("invalid-event");
      break;
    case "assistant-message":
      if (
        !onlyKeys(event, ["type", "runId", "sequence", "text"]) ||
        !isBoundedText(event.text, AGENT_RUNNER_EVENT_LIMITS.maxEventBytes)
      ) throw new AgentRunnerContractError("invalid-event");
      break;
    case "terminal":
      if (
        (event.status !== "completed" && event.status !== "failed" &&
          event.status !== "cancelled" && event.status !== "unknown") ||
        !onlyKeys(event, ["type", "runId", "sequence", "status", "message"]) ||
        (event.message !== undefined &&
          !isBoundedText(event.message, AGENT_RUNNER_EVENT_LIMITS.maxEventBytes))
      ) throw new AgentRunnerContractError("invalid-event");
      break;
    default:
      throw new AgentRunnerContractError("invalid-event");
  }

  const size = eventTextBytes(event);
  if (size > AGENT_RUNNER_EVENT_LIMITS.maxEventBytes)
    throw new AgentRunnerContractError("event-too-large");
  return event as AgentRunEvent;
}

function onlyKeys(event: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(event).every((key) => allowed.includes(key));
}

function eventTextBytes(event: Record<string, unknown>): number {
  let bytes = 128;
  for (const value of Object.values(event)) {
    if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
  }
  return bytes;
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

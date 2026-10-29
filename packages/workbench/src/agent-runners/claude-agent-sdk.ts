import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z, type ZodRawShape, type ZodType } from "zod";
import type {
  AgentCancelResult,
  AgentRun,
  AgentRunEvent,
  AgentRunInput,
  AgentRunToolResponse,
  AgentRunner,
  AgentRunnerDescription,
} from "./agent-runner.ts";

const DEFAULT_ENDPOINT = "https://api.anthropic.com";
const DEFAULT_MODEL = "sonnet";
const SDK_SERVER = "nomo_workbench";
const CANCEL_WAIT_MS = 5_000;

type RunnerOptions = {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly model?: string;
};

type PendingTool = { readonly resolve: (response: AgentRunToolResponse) => void };
type RunState = {
  readonly controller: AbortController;
  readonly done: Promise<"completed" | "failed" | "cancelled">;
};

type JsonSchema = Readonly<Record<string, unknown>>;

type UnsequencedAgentRunEvent<T = AgentRunEvent> =
  T extends AgentRunEvent ? Omit<T, "runId" | "sequence"> : never;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function assertEndpoint(endpoint: string): string {
  const parsed = new URL(endpoint);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    (parsed.hostname !== "api.anthropic.com" && !loopback) ||
    (parsed.hostname === "api.anthropic.com" && parsed.port !== "")
  ) throw new Error("Claude Agent SDK endpoint is not allowed.");
  return parsed.origin;
}

function fieldSchema(raw: JsonSchema): ZodType {
  const literal = raw.const;
  if (typeof literal === "string") return z.literal(literal);
  const enumValues = raw.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0 && enumValues.every((value) => typeof value === "string")) {
    const values = enumValues as [string, ...string[]];
    return z.enum(values);
  }
  if (raw.type === "string") {
    let schema = z.string();
    if (typeof raw.minLength === "number") schema = schema.min(raw.minLength);
    if (typeof raw.maxLength === "number") schema = schema.max(raw.maxLength);
    return schema;
  }
  if (raw.type === "integer") {
    let schema = z.number().int();
    if (typeof raw.minimum === "number") schema = schema.min(raw.minimum);
    if (typeof raw.maximum === "number") schema = schema.max(raw.maximum);
    return schema;
  }
  if (raw.type === "number") {
    let schema = z.number();
    if (typeof raw.minimum === "number") schema = schema.min(raw.minimum);
    if (typeof raw.maximum === "number") schema = schema.max(raw.maximum);
    return schema;
  }
  if (raw.type === "boolean") return z.boolean();
  throw new Error("Claude Agent SDK tool schema is unsupported.");
}

function toolShape(schema: JsonSchema): ZodRawShape {
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf : [schema];
  if (variants.length === 0 || !variants.every((variant) => variant && typeof variant === "object"))
    throw new Error("Claude Agent SDK tool schema is unsupported.");

  const properties = new Map<string, JsonSchema[]>();
  let required: Set<string> | undefined;
  for (const variant of variants as JsonSchema[]) {
    const variantProperties = variant.properties;
    if (!variantProperties || typeof variantProperties !== "object" || Array.isArray(variantProperties))
      throw new Error("Claude Agent SDK tool schema is unsupported.");
    for (const [name, definition] of Object.entries(variantProperties)) {
      if (!definition || typeof definition !== "object" || Array.isArray(definition))
        throw new Error("Claude Agent SDK tool schema is unsupported.");
      const definitions = properties.get(name) ?? [];
      definitions.push(definition as JsonSchema);
      properties.set(name, definitions);
    }
    const variantRequired = new Set<string>();
    if (Array.isArray(variant.required))
      for (const name of variant.required) {
        if (typeof name !== "string" || !Object.hasOwn(variantProperties, name))
          throw new Error("Claude Agent SDK tool schema is unsupported.");
        variantRequired.add(name);
      }
    if (required === undefined) required = variantRequired;
    else for (const name of required) if (!variantRequired.has(name)) required.delete(name);
  }

  const shape = Object.create(null) as Record<string, ZodType>;
  for (const [name, definitions] of properties) {
    const distinctConstants = [...new Set(definitions.map((definition) => definition.const).filter((value): value is string => typeof value === "string"))];
    let field = distinctConstants.length > 1
      ? z.enum(distinctConstants as [string, ...string[]])
      : fieldSchema(definitions[0]!);
    if (definitions.some((definition) => definition.type !== definitions[0]!.type && definition.const === undefined))
      throw new Error("Claude Agent SDK tool schema is unsupported.");
    if (!required?.has(name)) field = field.optional();
    shape[name] = field;
  }
  if (properties.size === 0) throw new Error("Claude Agent SDK tool schema is unsupported.");
  return shape as ZodRawShape;
}

class EventQueue implements AsyncIterable<AgentRunEvent> {
  private readonly values: AgentRunEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<AgentRunEvent>) => void> = [];
  private ended = false;

  push(value: AgentRunEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRunEvent> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export class ClaudeAgentSdkRunner implements AgentRunner {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly runs = new Map<string, RunState>();

  constructor(options: RunnerOptions) {
    if (!options.apiKey) throw new Error("Claude API key is required.");
    this.apiKey = options.apiKey;
    this.endpoint = assertEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    this.model = options.model ?? DEFAULT_MODEL;
  }

  describe(): AgentRunnerDescription {
    return {
      id: "claude-agent-sdk",
      displayName: "Claude Agent SDK",
      provider: "Anthropic",
      endpoint: this.endpoint,
      dataTransfer: "remote",
      dataSent: ["task", "system-prompt", "tool-arguments", "tool-results"],
      profiles: [this.model],
      execution: "local",
      toolAccess: "mediated",
      workspaceMode: "approved-copy",
      cancellation: "may-be-unknown",
    };
  }

  async start(input: AgentRunInput): Promise<AgentRun> {
    if (input.signal.aborted) throw new Error("Claude Agent SDK run was already cancelled.");
    const allowedTools = new Set(input.workspace.allowedTools);
    if (input.tools.some(({ name }) => !allowedTools.has(name)))
      throw new Error("Claude Agent SDK tools exceed the Workbench grant.");
    const id = randomUUID();
    const controller = new AbortController();
    const queue = new EventQueue();
    const pending = new Map<string, PendingTool>();
    let sequence = 0;
    let abortRequested = false;
    let terminalStatus: "completed" | "failed" | "cancelled" = "failed";
    const emit = (event: UnsequencedAgentRunEvent) => {
      queue.push({ ...event, runId: id, sequence: ++sequence } as AgentRunEvent);
    };
    const abortPending = () => {
      for (const [requestId, request] of pending) {
        request.resolve({ kind: "error", message: "Run cancelled." });
        pending.delete(requestId);
      }
    };
    const onInputAbort = () => controller.abort();
    const onControllerAbort = () => {
      abortRequested = true;
      abortPending();
    };
    const { promise: done, resolve: resolveDone } = deferred<"completed" | "failed" | "cancelled">();
    const events = input.tools.map((definition) => {

      return tool(definition.name, definition.description ?? "", toolShape(definition.inputSchema), async (args) => {
        if (controller.signal.aborted) return { content: [{ type: "text", text: "Run cancelled." }], isError: true };
        const requestId = randomUUID();
        const { promise, resolve } = deferred<AgentRunToolResponse>();
        pending.set(requestId, { resolve });
        emit({ type: "tool-request", requestId, toolName: definition.name, argsJson: JSON.stringify(args) });
        const response = await promise;
        pending.delete(requestId);
        const resultJson = response.kind === "result" ? response.resultJson : response.message;
        emit({ type: "tool-result", requestId, resultJson });
        return { content: [{ type: "text", text: resultJson }], isError: response.kind === "error" };
      }, { alwaysLoad: true });
    });
    const server = createSdkMcpServer({ name: SDK_SERVER, version: "1.0.0", alwaysLoad: true, tools: events });
    const temp = await mkdtemp(join(tmpdir(), "nomo-claude-agent-"));
    const configDir = join(temp, ".claude");
    await mkdir(configDir, { recursive: true });
    if (input.signal.aborted) {
      await rm(temp, { recursive: true, force: true });
      throw new Error("Claude Agent SDK run was already cancelled.");
    }
    input.signal.addEventListener("abort", onInputAbort, { once: true });
    controller.signal.addEventListener("abort", onControllerAbort, { once: true });
    if (input.signal.aborted) controller.abort();
    emit({ type: "status", status: "starting" });
    this.runs.set(id, { controller, done });

    const finished = (async () => {
      emit({ type: "status", status: "running" });
      try {
        for await (const message of query({
          prompt: input.task,
          options: {
            abortController: controller,
            allowedTools: input.tools.map(({ name }) => `mcp__${SDK_SERVER}__${name}`),
            cwd: temp,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: temp,
              TMPDIR: temp,
              CLAUDE_CONFIG_DIR: configDir,
              ANTHROPIC_API_KEY: this.apiKey,
              ANTHROPIC_BASE_URL: this.endpoint,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
              ENABLE_TOOL_SEARCH: "false",
              DISABLE_TELEMETRY: "1",
              DISABLE_ERROR_REPORTING: "1",
              DISABLE_FEEDBACK_COMMAND: "1",
              CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
              CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
              CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
            },
            maxTurns: 12,
            mcpServers: { [SDK_SERVER]: server },
            model: input.profileId ?? this.model,
            persistSession: false,
            permissionMode: "dontAsk",
            settingSources: [],
            strictMcpConfig: true,
            systemPrompt: input.systemPrompt,
            tools: [],
            stderr: () => undefined,
          },
        })) {
          if (message.type === "assistant" && message.parent_tool_use_id === null) {
            for (const block of message.message.content)
              if (block.type === "text" && block.text) emit({ type: "assistant-message", text: block.text });
          } else if (message.type === "result") {
            terminalStatus = abortRequested
              ? "cancelled"
              : message.subtype === "success" ? "completed" : "failed";
          }
        }
      } catch {
        terminalStatus = abortRequested ? "cancelled" : "failed";
      } finally {
        input.signal.removeEventListener("abort", onInputAbort);
        controller.signal.removeEventListener("abort", onControllerAbort);
        abortPending();
        try {
          await rm(temp, { recursive: true, force: true });
        } catch {
          terminalStatus = "failed";
        }
        emit({
          type: "terminal",
          status: terminalStatus,
          ...(terminalStatus === "failed" ? { message: "Claude agent run failed." } : {}),
        });
        queue.close();
        resolveDone(terminalStatus);
        this.runs.delete(id);
      }
    })();
    void finished.catch(() => undefined);

    return {
      id,
      events: queue,
      async respondToTool(requestId, response) {
        const request = pending.get(requestId);
        if (!request) throw new Error("Claude tool request is no longer pending.");
        request.resolve(response);
      },
    };
  }

  async cancel(runId: string): Promise<AgentCancelResult> {
    const state = this.runs.get(runId);
    if (!state) return "unknown";
    state.controller.abort();
    const { promise: timeout, resolve } = deferred<undefined>();
    const timer = setTimeout(() => resolve(undefined), CANCEL_WAIT_MS);
    const outcome = await Promise.race([state.done, timeout]);
    clearTimeout(timer);
    return outcome === "cancelled" ? "confirmed" : "unknown";
  }
}

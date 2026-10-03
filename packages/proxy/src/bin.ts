import process from "node:process";
import { readFile } from "node:fs/promises";

import {
  classifyTool,
  loadFacts,
  toEvaluationContext,
  validateFactsFile,
} from "../../registry/src/index.ts";
import type { FactsFile, FactsReport } from "../../registry/src/index.ts";
import { decide, HoldQueue, loadPolicy, policyDigest } from "../../policy/src/index.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { jsonlStore } from "../../ledger/src/store.ts";
import type { JsonlEntry, JsonlReceipt } from "../../ledger/src/store.ts";
import type { LedgerStore, KeyProvider } from "../../ledger/src/index.ts";
import type {
  PolicyCall,
  PolicyDecision,
  ValidPolicy,
} from "../../policy/src/index.ts";

import { forwardPromptMessage } from "./forward/prompts.ts";
import { forwardResourceMessage } from "./forward/resources.ts";
import {
  captureLegacyEnvelope,
  validateLegacyCapture,
  validateLegacyOutcome,
  type LegacyBindingResolver,
  type LegacyCaptureEvidence,
  type LegacyProxyBinding,
} from "./forward/legacy-binding.ts";
import { interceptCall } from "./forward/tools.ts";
import type {
  InterceptedCall,
  JsonRpcError,
  JsonRpcResult,
} from "./forward/tools.ts";
import type {
  JsonObject,
  JsonRpcErrorBody,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
} from "./rpc.ts";
import { relayNotification } from "./relay/notifications.ts";
import { relayServerRequest, relayServerResponse } from "./relay/requests.ts";
import type { JsonRpcResponse } from "./relay/requests.ts";
import { Session } from "./session.ts";
import {
  DEFAULT_INBOUND_MAX_BYTES,
  JsonRpcInputError,
  ProxyOutputError,
  assertInboundLineCeiling,
  assertOutboundLineCeiling,
  assertOutboundQueueCeiling,
  assertSingleJsonRpcMessage,
} from "./hardening.ts";
import { ReadBuffer, spawnUpstream } from "./transport/stdio.ts";
import { upstreamHttp } from "./transport/http.ts";
import type { UpstreamProcess } from "./transport/stdio.ts";

export type ProxyPosture = "fail-closed" | "observe" | "observe-only";
export type ProxyTransport = "stdio" | "http";
export type ProxyShutdownSignal = "SIGINT" | "SIGTERM";

export type ProxyShutdownSignals = {
  readonly on: (signal: ProxyShutdownSignal, handler: () => void) => void;
  readonly off: (signal: ProxyShutdownSignal, handler: () => void) => void;
  readonly setExitCode?: (code: number) => void;
};

export const SUPPORTED_TRANSPORTS: readonly ProxyTransport[] = [
  "stdio",
  "http",
];

export type UpstreamEvents = {
  readonly onMessage: (line: string) => void;
  readonly onClose: (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
  readonly onError: (error: Error) => void;
};

export type ProxyOptions = {
  readonly upstreamCommand?: readonly string[];
  readonly upstreamEnv?: Record<string, string>;
  readonly transport?: ProxyTransport;
  readonly upstreamUrl?: string;
  readonly policyPath: string;
  readonly factsPath?: string;
  readonly posture: ProxyPosture;
  readonly onHold?: (queue: HoldQueue) => void | (() => void);
  /** Ledger directory for the dev tier store. Required for the fail-closed posture. */
  readonly ledgerDir?: string;
  /** Optional signer for an embedded proxy; defaults to the development key. */
  readonly keyProvider?: KeyProvider;
  readonly workspace?: string;
  /**
   * WP-R02 capture gate for the legacy proxy path. Defaults to an envelope
   * snapshot of the call; rejection blocks the upstream forward. Tests inject
   * a failure here to prove a failed snapshot never reaches the upstream.
   */
  readonly legacyCapture?: (call: InterceptedCall) => Promise<unknown>;
  /** Optional durable host binding for explicitly supported legacy tools. */
  readonly legacyBinding?: LegacyBindingResolver;
  readonly upstreamSpawn?: (events: UpstreamEvents) => UpstreamProcess;
  readonly input?: AsyncIterable<string>;
  readonly output?: (line: string) => void;
  readonly error?: (line: string) => void;
  readonly inboundMaxBytes?: number;
  /** Cap for one outbound line and for bytes buffered in stdout behind a notification flood. Defaults to four inbound ceilings, which cannot be reached by relayed content; see the note in runProxy. */
  /**
   * Cap for upstream messages parsed but not yet handled. The transport reads
   * lines synchronously and each one joins a promise chain, so an upstream
   * that writes faster than a legacy binding resolves grows that chain without
   * bound. Past the cap, further lines are dropped with one named refusal.
   */
  readonly maxInflightUpstreamMessages?: number;
  readonly outboundMaxBytes?: number;
  readonly shutdownSignals?: ProxyShutdownSignals | false;
};

type InitializeRequest = {
  readonly agentId: JsonRpcId;
  readonly requestedVersion: string;
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;
const DEFAULT_MAX_INFLIGHT_UPSTREAM_MESSAGES = 512;

export async function runProxy(options: ProxyOptions): Promise<void> {
  const inboundMaxBytes = options.inboundMaxBytes ?? DEFAULT_INBOUND_MAX_BYTES;
  // The per-message outbound ceiling is four inbound ceilings by default, and
  // at that setting it cannot fire for relayed content: every sendJson payload
  // derives from one upstream line, and a line above the inbound ceiling is
  // refused at parse time. The effective bound on relayed bytes is the inbound
  // ceiling; this one exists for messages that compose several upstream parts.
  const outboundMaxBytes = options.outboundMaxBytes ?? inboundMaxBytes * 4;
  const maxInflightUpstreamMessages =
    options.maxInflightUpstreamMessages ?? DEFAULT_MAX_INFLIGHT_UPSTREAM_MESSAGES;
  if (!Number.isSafeInteger(maxInflightUpstreamMessages) || maxInflightUpstreamMessages < 1) {
    throw new RangeError("maxInflightUpstreamMessages must be a positive safe integer");
  }
  // The default stdout writer is drain aware: when a valid notification flood
  // leaves more than the queue cap unflushed, the line is refused with a named
  // error instead of queueing behind it without bound. Buffered bytes are read
  // from the stream itself, so no new queue is introduced to bound.
  const write =
    options.output ??
    ((line: string) => {
      assertOutboundQueueCeiling(
        process.stdout.writableLength,
        Buffer.byteLength(line, "utf8") + 1,
        outboundMaxBytes,
      );
      process.stdout.write(`${line}\n`);
    });
  const writeError =
    options.error ??
    ((line: string) => {
      process.stderr.write(`${line}\n`);
    });
  const startup = validateStartup(options, writeError);
  let policy: ValidPolicy;
  let facts: FactsReport;
  try {
    policy = await readPolicy(options.policyPath);
    facts = await readFacts(options.factsPath);
  } catch (error) {
    writeError(`startup failed: ${errorMessage(error)}`);
    throw error;
  }
  if (options.posture === "fail-closed" && options.ledgerDir === undefined) {
    // The fail-closed posture promises every decided call leaves a ledger
    // record. Without a ledger directory that promise cannot be kept, so the
    // proxy refuses at startup instead of crashing on the first tools/call.
    throw new Error("fail-closed posture requires a ledger directory");
  }
  const session = new Session();
  const queue = new HoldQueue();
  const stopHold = options.onHold?.(queue);
  // The dev tier ledger is a JSONL file store with a local ed25519 signer. In the
  // fail-closed posture the store must open before the first call routes, because
  // the posture promises that a call without a ledger record never forwards.
  const ledgerStore:
    LedgerStore<unknown, JsonlEntry, JsonlReceipt> | undefined =
    options.ledgerDir === undefined
      ? undefined
      : jsonlStore(options.keyProvider ?? (await devKeyProvider()), {
          dir: options.ledgerDir,
        });
  let resolveUpstreamClosed: () => void = () => {};
  const upstreamClosed = new Promise<void>((resolve) => {
    resolveUpstreamClosed = resolve;
  });

  const initializeByUpstream = new Map<JsonRpcId, InitializeRequest>();
  const pendingLegacy = new Map<
    JsonRpcId,
    {
      readonly binding: LegacyProxyBinding;
      readonly evidence: LegacyCaptureEvidence;
    }
  >();
  const unknownLegacy = new Set<JsonRpcId>();
  let upstreamWork = Promise.resolve();
  let inflightUpstreamMessages = 0;
  let upstreamBacklogRefused = false;
  let upstream: UpstreamProcess | null = null;

  const sendJson = (message: unknown): void => {
    // The per-message outbound ceiling gates upstream-relayed content only.
    // Oversize throws a named error; the upstream path below drops it.
    const line = JSON.stringify(message);
    assertOutboundLineCeiling(line, outboundMaxBytes);
    write(line);
  };
  const sendLocal = (message: unknown): void => {
    // Locally generated answers (parse errors, deny and hold verdicts) are
    // bounded by the inbound ceiling plus operator policy text, never by
    // upstream content, so they bypass the relay cap: capping them would turn
    // every small-cap deployment into a self denial on its first error.
    // The stdout queue guard in write still applies to every line.
    write(JSON.stringify(message));
  };
  const sendUpstream = (message: unknown): void => {
    if (upstream === null) throw new Error("upstream is not open");
    upstream.send(JSON.stringify(message));
  };

  const forwardAfterTranslate = (request: JsonRpcRequest): JsonRpcRequest => {
    const translated = session.translateRequestOut(request);
    sendUpstream(translated);
    return translated;
  };

  const finishLegacy = async (
    upstreamId: JsonRpcId,
    response: JsonRpcResult | JsonRpcError | null,
  ): Promise<void> => {
    const pending = pendingLegacy.get(upstreamId);
    if (pending === undefined) return;
    try {
      const outcome = await pending.binding.outcome(pending.evidence, response);
      validateLegacyOutcome(pending.evidence, response, outcome);
    } catch (error) {
      pendingLegacy.delete(upstreamId);
      unknownLegacy.add(upstreamId);
      throw error;
    }
    pendingLegacy.delete(upstreamId);
    if (response === null) unknownLegacy.add(upstreamId);
  };

  const markPendingLegacyUnknown = async (): Promise<void> => {
    for (const upstreamId of [...pendingLegacy.keys()]) {
      try {
        await finishLegacy(upstreamId, null);
      } catch {
        writeError("legacy outcome recording failed");
      }
    }
  };

  const forwardToolCall = async (
    request: JsonRpcRequest,
    bound: {
      readonly binding: LegacyProxyBinding;
      readonly evidence: LegacyCaptureEvidence;
    } | null,
  ): Promise<JsonRpcRequest> => {
    const translated = session.translateRequestOut(request);
    if (bound === null) {
      sendUpstream(translated);
      return translated;
    }
    try {
      await bound.binding.dispatched(bound.evidence);
    } catch {
      const failed: JsonRpcError = {
        jsonrpc: "2.0",
        id: translated.id,
        error: { code: INTERNAL_ERROR, message: "dispatch evidence failed" },
      };
      try {
        const outcome = await bound.binding.outcome(bound.evidence, failed);
        validateLegacyOutcome(bound.evidence, failed, outcome);
      } catch {
        throw new Error("legacy dispatch and failure evidence recording failed");
      }
      throw new Error("legacy dispatch evidence failed");
    }
    pendingLegacy.set(translated.id, bound);
    try {
      sendUpstream(translated);
    } catch {
      try {
        await finishLegacy(translated.id, null);
      } catch {
        throw new Error("legacy send and unknown evidence recording failed");
      }
      throw new Error("legacy upstream send failed");
    }
    return translated;
  };

  const handleUpstreamLine = async (line: string): Promise<void> => {
    let message: JsonRpcMessage;
    try {
      message = parseMessage(line, inboundMaxBytes);
    } catch {
      await markPendingLegacyUnknown();
      writeError("upstream sent malformed JSON-RPC message");
      return;
    }

    try {
      if (isResponse(message) && message.id !== undefined) {
        if (unknownLegacy.has(message.id)) {
          writeError("late legacy response dropped after unknown outcome");
          return;
        }
        if (pendingLegacy.has(message.id)) {
          await finishLegacy(message.id, message);
        }
      }

      if (isRequest(message)) {
        sendJson(relayServerRequest(message, session));
        return;
      }

      if (isNotification(message)) {
        const relayed = session.translateInbound(message);
        if (relayed !== null) sendJson(relayed);
        return;
      }

      if (
        isResponse(message) &&
        message.id !== undefined &&
        initializeByUpstream.has(message.id)
      ) {
        const init = initializeByUpstream.get(message.id)!;
        initializeByUpstream.delete(message.id);
        const translated = session.translateInbound(message);
        if (translated !== null)
          sendJson(rewriteInitializeResult(translated, session, init));
        return;
      }

      const translated = session.translateInbound(message);
      if (translated !== null) sendJson(translated);
    } catch (error) {
      // Fail closed on the relay path: a refused outbound line is dropped
      // with a named reason, never forwarded half-framed, and the session
      // stays up for the messages that fit. Anything else is a bug, rethrow.
      if (error instanceof ProxyOutputError) {
        writeError(`upstream message dropped: ${error.message}`);
        return;
      }
      throw error;
    }
  };

  let drained = false;
  let upstreamClosedFlag = false;
  let shutdownPromise: Promise<void> | null = null;
  const drainHolds = (): void => {
    if (drained) return;
    drained = true;
    if (typeof stopHold === "function") stopHold();
    queue.close();
  };
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      drainHolds();
      if (!upstreamClosedFlag) upstream?.close();
      upstreamWork = upstreamWork.then(markPendingLegacyUnknown);
      await upstreamWork;
      resolveUpstreamClosed();
    })();
    return shutdownPromise;
  };

  const handleUpstreamClose = (): void => {
    upstreamClosedFlag = true;
    drainHolds();
    upstreamWork = upstreamWork
      .then(markPendingLegacyUnknown)
      .finally(resolveUpstreamClosed);
  };

  try {
    const upstreamEvents: UpstreamEvents = {
      onMessage(line) {
        if (inflightUpstreamMessages >= maxInflightUpstreamMessages) {
          if (!upstreamBacklogRefused) {
            upstreamBacklogRefused = true;
            writeError(
              `upstream backlog exceeded ${maxInflightUpstreamMessages} unhandled messages; further lines are dropped until it drains`,
            );
          }
          return;
        }
        inflightUpstreamMessages += 1;
        upstreamWork = upstreamWork
          .then(() => handleUpstreamLine(line))
          .catch(() => {
            writeError("upstream message handling failed");
          })
          .finally(() => {
            inflightUpstreamMessages -= 1;
            upstreamBacklogRefused = false;
          });
      },
      onClose: handleUpstreamClose,
      onError() {
        writeError("upstream error");
        upstreamWork = upstreamWork.then(markPendingLegacyUnknown);
      },
    };
    upstream =
      startup.transport === "http"
        ? upstreamHttp(startup.url, { events: upstreamEvents })
        : options.upstreamSpawn === undefined
          ? spawnUpstream(
              startup.command,
              options.upstreamEnv ?? cleanEnv(process.env),
              { events: upstreamEvents },
            )
          : options.upstreamSpawn(upstreamEvents);
  } catch (error) {
    throw new UpstreamStartError(errorMessage(error));
  }

  const shutdownSignals =
    options.shutdownSignals === false
      ? null
      : (options.shutdownSignals ?? processShutdownSignals());
  const sigint = (): void => {
    shutdownSignals?.setExitCode?.(130);
    void shutdown();
  };
  const sigterm = (): void => {
    shutdownSignals?.setExitCode?.(143);
    void shutdown();
  };
  shutdownSignals?.on("SIGINT", sigint);
  shutdownSignals?.on("SIGTERM", sigterm);

  const handleAgentLine = async (line: string): Promise<void> => {
    let message: JsonRpcMessage;
    try {
      message = parseMessage(line, inboundMaxBytes);
    } catch (error) {
      const failure = parseFailure(error);
      sendLocal(jsonRpcError(null, failure.code, failure.message));
      return;
    }

    const responseId =
      "id" in message && message.id !== undefined ? message.id : null;
    try {
      if (isRequest(message)) {
        if (message.method === "initialize") {
          const translated = session.translateRequestOut(message);
          initializeByUpstream.set(translated.id, {
            agentId: message.id,
            requestedVersion: readProtocolVersion(message.params),
          });
          sendUpstream(translated);
          return;
        }

        if (message.method === "tools/call") {
          await handleToolCall(
            message,
            policy,
            facts,
            queue,
            forwardToolCall,
            sendLocal,
            writeError,
            normalizePosture(options.posture),
            ledgerStore,
            options.workspace ?? "default",
            options.legacyCapture,
            options.legacyBinding,
          );
          return;
        }

        if (isResourceMethod(message.method)) {
          await forwardResourceMessage(message, async (request) =>
            forwardAfterTranslate(request),
          );
          return;
        }

        if (isPromptMethod(message.method)) {
          await forwardPromptMessage(message, async (request) =>
            forwardAfterTranslate(request),
          );
          return;
        }

        forwardAfterTranslate(message);
        return;
      }

      if (isNotification(message)) {
        const cancel = cancellationFromAgent(message, session);
        if (cancel !== null) {
          sendUpstream(cancel);
          return;
        }
        sendUpstream(relayNotification(message, session.maps).notification);
        return;
      }

      sendUpstream(relayServerResponse(message as JsonRpcResponse, session.maps.upstreamToAgent));
    } catch (error) {
      writeError(`request failed: ${errorMessage(error)}`);
      sendLocal(jsonRpcError(responseId, INTERNAL_ERROR, "Internal error"));
    }
  };

  const input = (options.input ?? stdinLines(inboundMaxBytes))[
    Symbol.asyncIterator
  ]();
  try {
    for (;;) {
      let next: IteratorResult<string>;
      try {
        next = await Promise.race([
          input.next(),
          upstreamClosed.then(
            () => ({ done: true, value: undefined }) as IteratorResult<string>,
          ),
        ]);
      } catch (error) {
        // Fail closed on unreadable stdin: one overlong unterminated line ends
        // the agent session after a single Invalid Request. Resuming mid-stream
        // would misframe the line's tail as a new message, so the session ends
        // instead of guessing where the next message starts.
        if (error instanceof JsonRpcInputError) {
          sendLocal(jsonRpcError(null, INVALID_REQUEST, "Invalid Request"));
          break;
        }
        throw error;
      }
      if (next.done === true) break;
      await handleAgentLine(next.value);
    }
  } finally {
    shutdownSignals?.off("SIGINT", sigint);
    shutdownSignals?.off("SIGTERM", sigterm);
    await input.return?.();
    await shutdown();
  }
}

export class PolicyStartupError extends Error {}
export class ProxyStartupError extends Error {}
export class UpstreamStartError extends Error {}

type StartupConfig =
  | { readonly transport: "stdio"; readonly command: readonly string[] }
  | { readonly transport: "http"; readonly url: URL };

function validateStartup(
  options: ProxyOptions,
  writeError: (line: string) => void,
): StartupConfig {
  const transport = options.transport ?? "stdio";
  if (!isSupportedProxyTransport(transport)) {
    throw new ProxyStartupError(
      `transport must be one of ${SUPPORTED_TRANSPORTS.join(", ")}`,
    );
  }

  if (transport === "http") {
    if (options.upstreamUrl === undefined || options.upstreamUrl === "") {
      const error = new ProxyStartupError(
        "http transport requires upstreamUrl",
      );
      writeError(`startup failed: ${error.message}`);
      throw error;
    }
    try {
      return { transport, url: new URL(options.upstreamUrl) };
    } catch (error) {
      throw new ProxyStartupError(
        `invalid upstreamUrl: ${errorMessage(error)}`,
      );
    }
  }

  if (options.upstreamUrl !== undefined) {
    writeError("startup warning: upstreamUrl is ignored for stdio transport");
  }
  if (
    options.upstreamSpawn === undefined &&
    (options.upstreamCommand === undefined ||
      options.upstreamCommand.length === 0)
  ) {
    throw new UpstreamStartError(
      "stdio transport requires an upstream command",
    );
  }
  return { transport, command: options.upstreamCommand ?? [] };
}

function isSupportedProxyTransport(value: string): value is ProxyTransport {
  return (SUPPORTED_TRANSPORTS as readonly string[]).includes(value);
}

function processShutdownSignals(): ProxyShutdownSignals {
  return {
    on(signal, handler) {
      process.on(signal, handler);
    },
    off(signal, handler) {
      process.off(signal, handler);
    },
    setExitCode(code) {
      process.exitCode = code;
    },
  };
}

async function readPolicy(path: string): Promise<ValidPolicy> {
  const text = await readFile(path, "utf8");
  const loaded = loadPolicy(text);
  if (!loaded.ok) throw new PolicyStartupError(loaded.errors.join("; "));
  return loaded;
}

async function readFacts(path: string | undefined): Promise<FactsReport> {
  if (path === undefined) return loadFacts({ facts: {} }, new Date());
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const errors = validateFactsFile(raw);
  if (errors.length > 0) throw new PolicyStartupError(errors.join("; "));
  return loadFacts(raw as FactsFile, new Date());
}

async function handleToolCall(
  request: JsonRpcRequest,
  policy: ValidPolicy,
  facts: FactsReport,
  queue: HoldQueue,
  forward: (
    request: JsonRpcRequest,
    bound: {
      readonly binding: LegacyProxyBinding;
      readonly evidence: LegacyCaptureEvidence;
    } | null,
  ) => Promise<JsonRpcRequest>,
  sendJson: (message: unknown) => void,
  writeError: (line: string) => void,
  posture: "fail-closed" | "observe",
  ledgerStore: LedgerStore<unknown, JsonlEntry, JsonlReceipt> | undefined,
  workspace: string,
  legacyCapture?: (call: InterceptedCall) => Promise<unknown>,
  legacyBinding?: LegacyBindingResolver,
): Promise<void> {
  const call = { ...interceptedCall(request), workspace };
  let binding: LegacyProxyBinding | null = null;
  if (posture === "fail-closed" && legacyBinding !== undefined) {
    try {
      binding = legacyBinding(call);
    } catch {
      throw new Error("legacy binding resolution failed");
    }
  }
  if (binding !== null && binding.tool !== call.tool) {
    throw new Error("legacy binding tool mismatch");
  }
  let capturedEvidence: LegacyCaptureEvidence | null = null;
  let lastPolicyCall: PolicyCall | null = null;
  let lastDecision: PolicyDecision | null = null;
  const policyFn = (policyCall: PolicyCall): PolicyDecision => {
    lastPolicyCall = policyCall;
    const decision = decide(policy, policyCall);
    lastDecision = decision;
    if (posture === "observe" && decision.kind !== "allow") {
      writeError(
        `observe: ${decision.kind} verdict for ${policyCall.tool} forwarded`,
      );
      return { kind: "allow" };
    }
    return decision;
  };

  const verdict = await interceptCall(call, {
    classify: () =>
      classifyTool(call.tool, toEvaluationContext(facts, call.args)),
    policy: policyFn,
    // One digest of the loaded policy, computed from the content rather than
    // the file bytes, so the record names the policy a reviewer can also
    // obtain. Scoped to this request because the policy is reloaded for one.
    policyDigest: () => policyDigest(policy.policy),
    capture:
      binding === null
        ? (legacyCapture ??
          (async (candidate, argsDigest) =>
            captureLegacyEnvelope(
              candidate.tool,
              candidate.args,
              candidate.workspace ?? workspace,
              argsDigest,
            )))
        : async (candidate, argsDigest) => {
            const evidence = await binding.capture(candidate, argsDigest);
            validateLegacyCapture(candidate, argsDigest, evidence);
            capturedEvidence = evidence;
            return evidence;
          },
    hold: (seconds) => {
      const decision = lastDecision;
      const policyCall = lastPolicyCall;
      if (decision === null || decision.kind !== "hold" || policyCall === null)
        throw new Error("hold decision state missing");
      return queue.hold(
        {
          tool: call.tool,
          klass: policyCall.klass,
          blastRadius: policyCall.blastRadius,
          ruleIndex: decision.ruleIndex,
          rationale: decision.rationale,
          args: call.args,
          notify: decision.notify,
        },
        seconds,
      );
    },
    ledger: async (entry) => {
      // Fail-closed startup already refuses to run without a store. Reaching
      // here without one can only be observe posture, which degrades to a
      // loud stderr note per call rather than blocking the trial it exists
      // for; silently recording nothing would be the dishonest middle.
      if (ledgerStore === undefined) {
        writeError(
          `observe: no ledger directory, record skipped for ${entry.tool}`,
        );
        return;
      }
      await ledgerStore.append({ ...entry, workspace });
    },
  });

  if (verdict.kind === "allow") {
    await forward(
      request,
      binding === null || capturedEvidence === null
        ? null
        : { binding, evidence: capturedEvidence },
    );
    return;
  }

  if (verdict.kind === "deny") {
    sendJson({ ...verdict.error, id: request.id });
    return;
  }

  const held = await verdict.promise;
  if ("error" in held) {
    sendJson({ ...held, id: request.id });
    return;
  }
  await forward(
    request,
    binding === null || capturedEvidence === null
      ? null
      : { binding, evidence: capturedEvidence },
  );
}

function interceptedCall(request: JsonRpcRequest): InterceptedCall {
  const params = request.params ?? {};
  const name = params.name;
  const args = params.arguments;
  if (typeof name !== "string" || name === "")
    throw new TypeError("tools/call params.name is required");
  if (args !== undefined && !isObject(args))
    throw new TypeError("tools/call params.arguments must be an object");
  return {
    tool: name,
    connector: connectorFromName(name),
    args: immutableClone(args === undefined ? {} : args),
  };
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function connectorFromName(name: string): string {
  const dot = name.indexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

function rewriteInitializeResult(
  message: JsonRpcMessage,
  session: Session,
  init: InitializeRequest,
): JsonRpcMessage {
  if (!("result" in message) || !isObject(message.result)) return message;
  const upstreamVersion =
    typeof message.result.protocolVersion === "string"
      ? message.result.protocolVersion
      : init.requestedVersion;
  return {
    ...message,
    id: init.agentId,
    result: {
      ...message.result,
      protocolVersion: session.negotiatedVersion(
        init.requestedVersion,
        upstreamVersion,
      ),
    },
  };
}

function cancellationFromAgent(
  notification: JsonRpcNotification,
  session: Session,
): JsonRpcNotification | null {
  if (notification.method !== "notifications/cancelled") return null;
  const params = notification.params;
  if (params === undefined) return null;
  const requestId = params.requestId;
  if (typeof requestId !== "number" && typeof requestId !== "string")
    return null;
  return session.translateCancellation(requestId);
}

/**
 * Bounded agent stdin. readline buffers an unterminated line without limit
 * before the line ceiling ever sees it, so raw chunks go through the same
 * ReadBuffer the upstream transport uses. An overlong line throws the named
 * input error and ends the read; the caller answers one Invalid Request and
 * closes the session rather than framing the line's tail as a new message.
 * The stream parameter exists so tests can feed hostile chunks without stdin.
 */
export async function* stdinLines(
  maxBytes = DEFAULT_INBOUND_MAX_BYTES,
  stream: AsyncIterable<Buffer | string> = process.stdin,
): AsyncIterable<string> {
  const buffer = new ReadBuffer(maxBytes);
  for await (const chunk of stream) {
    try {
      buffer.append(chunk);
    } catch {
      // ReadBuffer already cleared itself; name the refusal for the log.
      throw new JsonRpcInputError(
        "invalid",
        `inbound message exceeded ${maxBytes} bytes`,
      );
    }
    for (;;) {
      const line = buffer.readLine();
      if (line === null) break;
      yield line;
    }
  }
}

function parseMessage(
  line: string,
  maxBytes = DEFAULT_INBOUND_MAX_BYTES,
): JsonRpcMessage {
  assertInboundLineCeiling(line, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new JsonRpcInputError("parse", "Parse error");
  }
  assertSingleJsonRpcMessage(parsed);
  return parsed;
}

function parseFailure(error: unknown): {
  readonly code: number;
  readonly message: string;
} {
  if (error instanceof JsonRpcInputError) {
    return {
      code: error.kind === "parse" ? PARSE_ERROR : INVALID_REQUEST,
      message: error.kind === "parse" ? "Parse error" : "Invalid Request",
    };
  }
  return { code: INVALID_REQUEST, message: "Invalid Request" };
}

function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorBody;
} {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

function isNotification(
  message: JsonRpcMessage,
): message is JsonRpcNotification {
  return "method" in message && !("id" in message);
}

function isResponse(
  message: JsonRpcMessage,
): message is JsonRpcResult | JsonRpcError {
  return "result" in message || "error" in message;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProtocolVersion(params: JsonObject | undefined): string {
  return typeof params?.protocolVersion === "string"
    ? params.protocolVersion
    : "2025-11-25";
}

function isResourceMethod(method: string): boolean {
  return (
    method === "resources/list" ||
    method === "resources/read" ||
    method === "resources/subscribe" ||
    method === "resources/unsubscribe"
  );
}

function isPromptMethod(method: string): boolean {
  return method === "prompts/list" || method === "prompts/get";
}

function normalizePosture(posture: ProxyPosture): "fail-closed" | "observe" {
  return posture === "observe" || posture === "observe-only"
    ? "observe"
    : "fail-closed";
}

const UPSTREAM_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "COMSPEC",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
] as const;

function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const name = process.platform === "win32" ? key.toUpperCase() : key;
    if (
      value !== undefined &&
      UPSTREAM_ENV_ALLOWLIST.some((allowed) => allowed === name)
    )
      out[key] = value;
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

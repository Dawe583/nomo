import { page, filterRows, capabilities, activity, serverPermissionMode, DEFAULT_HTTP_PERMISSION_MODE } from '../../../packages/workbench/src/gui.ts';
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, posix, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { harnessSettingsView } from "../../../packages/workbench/src/harness-settings.ts";
import type { HoldBinding } from "../../../packages/policy/src/hold.ts";

import { runReplayCommand } from "../../../packages/cli/src/replay.ts";
import type { ReplayCommandOptions } from "../../../packages/cli/src/replay.ts";
import { buildGraph, DATA_EDGE_HONESTY_NOTE } from "../../../packages/ledger/src/taint/graph.ts";
import { neighbors } from "../../../packages/ledger/src/taint/query.ts";
import { readLedgerEntries, verifyChain } from "../../../packages/ledger/src/verify.ts";
import { GENESIS_PREV } from "../../../packages/ledger/src/canonical.ts";
import { readLedgerFeed, type LedgerFeedRecord } from "../../../packages/ledger/src/feed.ts";
import type { PublicKeyLookup } from "../../../packages/ledger/src/verify.ts";
import { Workbench } from "../../../packages/workbench/src/index.ts";
import { normalizeProviderConfig } from "../../../packages/workbench/src/provider.ts";
import { authorizedRemote } from "./auth.ts";
import { localApprovals } from "./local-approvals.ts";
import { desktopSetup, importDesktopProvider } from './desktop-setup.ts';
import {
  NO_VERIFICATION_KEY_NOTE,
  resolveVerificationKey,
  verificationKeyNote,
  type VerificationFacts,
  type VerificationKeySource,
} from "../../../packages/ledger/src/verify-key.ts";
import { handleCompanionRequest } from "./companion/routes.ts";
import { handleCompanionEnvelopeRequest } from "./companion/envelope.ts";
import {
  FleetEventStore,
  type FleetEvent,
  type FleetEventInput,
} from "./fleet-events.ts";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type PendingApproval = {
  readonly holdId: string;
  readonly call: unknown;
  readonly binding?: HoldBinding;
  readonly operationSummary?: string;
  readonly expiresAt: string | number;
  readonly status: ApprovalStatus;
};

export type ApprovalDecision = {
  readonly kind: "approved" | "denied";
  readonly by: string;
  readonly reason?: string;
};

export type ApprovalBroker = {
  readonly pending?: () => Promise<readonly PendingApproval[]> | readonly PendingApproval[];
  readonly listPending?: () => Promise<readonly PendingApproval[]> | readonly PendingApproval[];
  readonly review?: (holdId: string) => { readonly summary: string } | undefined;
  readonly decide: (holdId: string, decision: ApprovalDecision) => Promise<unknown> | unknown;
};

export type ControlPlaneOptions = {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly webRoot?: string;
  readonly ledgerPath?: string;
  readonly approvals?: ApprovalBroker;
  readonly replay?: ReplayCommandOptions;
  /** Test seam: a pre-configured Workbench replaces the default instance. */
  readonly workbench?: Workbench;
  /** Per-server fleet event store; tests create many servers, so no module singleton. */
  readonly fleetEvents?: FleetEventStore;
};

export type ListenHandle = {
  readonly port: number;
  readonly server: Server;
  readonly close: () => Promise<void>;
};

type JsonObject = Record<string, unknown>;

type RouteOptions = {
  readonly workbench: Workbench;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly webRoot: string;
  readonly ledgerPath?: string;
  readonly approvals?: ApprovalBroker;
  readonly replay?: ReplayCommandOptions;
  readonly fleetEvents: FleetEventStore;
  readonly publicKey?: PublicKeyLookup;
  /**
   * The resolved key, with its origin. `degraded` means private key material
   * was involved, so a replaced key file cannot be detected in that mode;
   * `operatorSupplied` means the operator chose these bytes somewhere the
   * agent cannot reach, which the default trust file is not.
   */
  readonly verificationKey?: {
    readonly publicKey: PublicKeyLookup;
    readonly keyId: string;
    readonly source: VerificationKeySource;
    readonly degraded: boolean;
    readonly operatorSupplied: boolean;
  };
};

const here = fileURLToPath(new URL(".", import.meta.url));
const defaultWebRoot = resolve(here, "../web");
const maxBodyBytes = 64 * 1024;

/**
 * Transport bounds for a session event stream. A subscriber that stops
 * reading must not grow the socket buffer for the life of the connection, so
 * writes are refused once the pending bytes pass the ceiling and a write that
 * returns false is waited on under a named drain deadline rather than left
 * buffering. The buffer ceiling mirrors the HTTP relay's SSE default, and the
 * drain deadline the relay's 30s abandon. One session, one stream is the
 * honest default for a local control plane; a second concurrent subscriber is
 * refused with a named status instead of silently splitting the stream.
 */
export const CONTROL_PLANE_SSE_MAX_BUFFER_BYTES = 1024 * 1024;
export const CONTROL_PLANE_SSE_DRAIN_TIMEOUT_MS = 30_000;
export const CONTROL_PLANE_SSE_MAX_STREAMS_PER_SESSION = 1;
export const CONTROL_PLANE_SSE_STREAM_IN_USE_STATUS = 409;
const CONTROL_PLANE_SSE_HEARTBEAT_MS = 1_000;

/** One live subscriber per session, keyed by session id. */
const activeStreams = new Map<string, SessionStream>();

/**
 * A session event stream with the same shape as the HTTP relay's
 * `PendingHttpResponse`: every frame is measured against the pending bytes
 * before it is written, a refused write queues until `drain`, and the drain
 * deadline destroys the response rather than leaving it buffering. The
 * heartbeat is part of the stream, so a refusal stops it too.
 */
class SessionStream {
  readonly #response: ServerResponse;
  readonly #id: string;
  readonly #frames: string[] = [];
  #queuedBytes = 0;
  #backpressured = false;
  #drainTimer: NodeJS.Timeout | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(response: ServerResponse, id: string) {
    this.#response = response;
    this.#id = id;
  }

  start(workbench: Workbench, id: string, after: number): void {
    let lastEventId = after;
    this.#response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const emit = () => {
      const current = workbench.get(id);
      for (const event of current?.events.filter(e => e.seq > lastEventId) ?? []) {
        if (!this.#sendFrame(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)) return;
        lastEventId = event.seq;
      }
      this.#sendFrame(': heartbeat\n\n');
    };
    this.#response.once('close', () => this.#stop());
    emit();
    if (this.#closed) return;
    this.#heartbeat = setInterval(emit, CONTROL_PLANE_SSE_HEARTBEAT_MS);
  }

  #sendFrame(frame: string): boolean {
    if (this.#closed) return false;
    const size = Buffer.byteLength(frame);
    if (size + this.#queuedBytes + this.#response.writableLength > CONTROL_PLANE_SSE_MAX_BUFFER_BYTES) {
      this.#stop();
      this.#response.destroy();
      return false;
    }
    if (this.#backpressured) {
      this.#frames.push(frame);
      this.#queuedBytes += size;
    } else if (!this.#response.write(frame)) {
      this.#waitForDrain();
    }
    return true;
  }

  #waitForDrain(): void {
    this.#backpressured = true;
    this.#response.once('drain', () => this.#flush());
    this.#drainTimer = setTimeout(() => {
      this.#stop();
      this.#response.destroy();
    }, CONTROL_PLANE_SSE_DRAIN_TIMEOUT_MS);
    this.#drainTimer.unref();
  }

  #flush(): void {
    this.#backpressured = false;
    clearTimeout(this.#drainTimer ?? undefined);
    this.#drainTimer = null;
    while (this.#frames.length > 0) {
      const frame = this.#frames.shift();
      if (frame === undefined) break;
      this.#queuedBytes -= Buffer.byteLength(frame);
      if (!this.#response.write(frame)) {
        this.#waitForDrain();
        return;
      }
    }
  }

  /** Ends the stream: the heartbeat stops and the session slot is released. */
  #stop(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat !== null) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
    clearTimeout(this.#drainTimer ?? undefined);
    this.#drainTimer = null;
    this.#frames.length = 0;
    this.#queuedBytes = 0;
    if (activeStreams.get(this.#id) === this) activeStreams.delete(this.#id);
  }
}
const publicScriptPaths: ReadonlySet<string> = new Set(["/app.js", "/workbench.css", "/theme.js", "/sessions.js", "/workspace-ui.js", "/cloud-settings.js", "/manifest.webmanifest", "/icon.svg"]);

/**
 * Resolve the verification key without ever generating one, and without
 * reading the private key file the ledger was signed with: a key resolved
 * from `dev-ed25519.pkcs8` is the writer's key, so a server that resolved it
 * that way would report an attacker's rewritten chain as valid
 * (docs/THREAT-MODEL.md §2.4). A public key comes from `VOID_VERIFY_KEY` or a
 * trust file; a trust file at the default `~/.void/trust/` path reports
 * `operatorSupplied: false`, because it shares a tree with the key it is
 * supposed to anchor. A configured `VOID_SIGNING_KEY` is still honoured,
 * because naming it is an explicit operator choice, and the response says it
 * was degraded. With nothing configured the lookup stays undefined and every
 * feed and verify view reports integrity without claiming authentication.
 */
async function resolveVerifyKey(
  env: Readonly<NodeJS.ProcessEnv>,
): Promise<RouteOptions["verificationKey"]> {
  const resolved = await resolveVerificationKey({ env });
  if (resolved === undefined) return undefined;
  return {
    publicKey: resolved.publicKey,
    keyId: resolved.keyId,
    source: resolved.source,
    degraded: resolved.degraded,
    operatorSupplied: resolved.operatorSupplied,
  };
}

export function createControlPlaneServer(options: ControlPlaneOptions = {}): Server {
  const env = options.env ?? process.env;
  const built = fileURLToPath(new URL('../../../dist/web', import.meta.url));
  const webRoot = resolve(options.webRoot ?? (existsSync(join(built, 'index.html')) ? built : defaultWebRoot));

  // The remote-facing API stays locked unless a human opens it explicitly.
  // Stated as a named constant so the divergence from the local operator
  // default is deliberate and reviewable, not an accident of two different
  // expressions in two files.
  const workbench = options.workbench ?? new Workbench({ ...env, VOID_PERMISSION_MODE: serverPermissionMode(env.VOID_PERMISSION_MODE ?? DEFAULT_HTTP_PERMISSION_MODE) });
  const fleetEventStore = options.fleetEvents ?? new FleetEventStore();
  const server = createServer((request, response) => {
    if (env.VOID_CONTROL_TOKEN ? !authorizedRemote(request, env) : !isLocalRequest(request)) {
      sendJson(response, 403, { error: "local_origin_required" });
      return;
    }
    void resolveVerifyKey(env).then((verificationKey) =>
      route(request, response, { ...options, env, webRoot, publicKey: verificationKey?.publicKey, verificationKey, workbench, fleetEvents: fleetEventStore, approvals: workbench.list().length ? { pending: async () => [...await readPendingApprovals(options.approvals), ...workbench.pending()], decide: (id, decision) => id.includes(":") ? workbench.decide(id, decision) : options.approvals?.decide(id, decision) } : options.approvals })).catch(() => {
      sendJson(response, 500, {
        error: "internal_error",
        message: "The request failed; operator review required",
      });
    });
  });
  server.once("close", () => workbench.close());
  return server;
}

export async function listenControlPlane(options: ControlPlaneOptions = {}): Promise<ListenHandle> {
  const server = createControlPlaneServer(options);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("control plane did not bind a TCP port");
  return {
    port: address.port,
    server,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
    }),
  };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: RouteOptions,
): Promise<void> {
  const parsed = parseRequestUrl(request);
  if (parsed === null) return sendJson(response, 400, { error: "bad_url" });

  const query = parsed.searchParams, wb = options.workbench;
  try {
    const desktop = !!options.env.VOID_DESKTOP_WEB_ROOT && !options.env.VOID_CONTROL_TOKEN && isLocalRequest(request);
    if (parsed.pathname === '/api/capabilities' && request.method === 'GET') return sendJson(response, 200, { ...capabilities('local', serverPermissionMode(options.env.VOID_PERMISSION_MODE), wb.harnessSettings()), desktopSetup: desktop });
    if (parsed.pathname === '/api/projects') {
      if (request.method === 'GET') { const projects = wb.projects(); return sendJson(response, 200, { items: projects, projects }); }
      if (request.method === 'POST') return sendJson(response, 200, { project: wb.upsertProject(await readJsonBody(request) as Parameters<Workbench['upsertProject']>[0]) });
    }
    const stopRun = /^\/api\/runs\/([A-Za-z0-9_-]+)\/stop$/.exec(parsed.pathname);
    if (stopRun && request.method === 'POST') {
      if (!wb.get(stopRun[1]!)) return sendJson(response, 404, { message: 'Session not found.' });
      // The acknowledgement records that this process accepted the stop, not
      // that every in-flight call has resolved: an already dispatched call
      // stays visible as in flight until its result is confirmed.
      options.fleetEvents.record({ kind: "stop_requested", agentId: stopRun[1]!, sessionId: stopRun[1]!, label: "operator requested run stop" });
      wb.stopRun(stopRun[1]!);
      options.fleetEvents.record({ kind: "stop_acknowledged", agentId: stopRun[1]!, sessionId: stopRun[1]!, label: "this process acknowledged the stop; local kill scope only" });
      return sendJson(response, 200, { ok: true, ack: options.fleetEvents.stopAck(stopRun[1]!), scope: "this process only" });
    }
    if (request.method === 'GET' && parsed.pathname === '/api/agents') return sendJson(response, 200, options.workbench.agents());
    if (request.method === 'POST' && parsed.pathname === '/api/agents') {
      const agent = wb.upsertAgent(await readJsonBody(request));
      options.fleetEvents.record({ kind: "agent_started", agentId: agent.id, label: "agent registered" });
      return sendJson(response, 200, { agent });
    }
    if (request.method === 'POST' && parsed.pathname === '/api/hooks') return sendJson(response, 200, { hook: wb.upsertHook(await readJsonBody(request)) });
    if (request.method === 'GET' && parsed.pathname === '/api/integrations') return sendJson(response, 200, { supported: false, integrations: [] });
    if (request.method === 'GET' && parsed.pathname === '/api/demo/status') return sendJson(response, 200, { supported: false, available: false });
    if (parsed.pathname === '/api/desktop/setup') {
      if (!desktop) return sendJson(response, 404, { error: 'not_available' });
      if (request.method === 'GET') return sendJson(response, 200, await desktopSetup(options.env));
      if (request.method === 'POST') {
        const body = await readJsonBody(request) as Record<string, unknown> | null;
        if (!body || typeof body !== 'object' || Object.keys(body).some(key => key !== 'source')) return sendJson(response, 400, { error: 'invalid_import' });
        return sendJson(response, 200, await importDesktopProvider(body.source, options.env, wb));
      }
      return sendJson(response, 405, { error: 'method_not_allowed' });
    }
    if (parsed.pathname === '/api/tools' && request.method === 'GET') return sendJson(response, 200, wb.availableTools(query.get('session') || undefined));
    if (parsed.pathname === '/api/preferences') {
      if (request.method === 'GET') return sendJson(response, 200, { preferences: wb.getPreferences() });
      if (request.method === 'PATCH') return sendJson(response, 200, { preferences: wb.patchPreferences(await readJsonBody(request) as Record<string, unknown>) });
    }
    if (parsed.pathname === '/api/harness-settings') {
      if (request.method === 'GET') { const settings = wb.harnessSettings(); return sendJson(response, 200, { settings, rows: harnessSettingsView(settings) }); }
      // A refused patch throws out of `harnessSettingsPatch`, and the shared
      // catch below turns that into the same 409 the preferences route returns
      // for a refused one. An unknown limit must read as refused, not as a
      // silent no-op the operator would take for an applied change.
      if (request.method === 'PATCH') { const settings = wb.patchHarnessSettings(await readJsonBody(request) as Record<string, unknown>); return sendJson(response, 200, { settings, rows: harnessSettingsView(settings) }); }
    }
    if (['/api/runs','/api/usage','/api/overview'].includes(parsed.pathname) && request.method === 'GET') {
      const data = activity(wb.allViews()); if (parsed.pathname === '/api/overview') {
        // Fleet view (plan Task 7): one registered agent and its current run,
        // this process's stop acknowledgement, and unconfirmed in-flight calls.
        // Labels only — the event store's input type cannot carry a token or a
        // prompt, so the overview cannot leak one either.
        const events = options.fleetEvents.latest(5);
        const agentRun = data.runs[0];
        return sendJson(response, 200, {
          ...data.overview,
          pendingApprovals: wb.pending().length,
          documents: wb.documentsList().length,
          agentId: agentRun?.id,
          runState: agentRun?.state,
          // This counts running or stopping runs, not individual calls. Run
          // state cannot prove whether an upstream call was dispatched or its
          // result was confirmed.
          inFlight: data.runs.filter((run) => run.state === "running" || run.state === "stopping").length,
          stopAck: options.fleetEvents.stopAck(agentRun?.sessionId ?? undefined),
          latestEvents: events,
        });
      }
      const rows = parsed.pathname === '/api/runs' ? data.runs : data.usage; return sendJson(response, 200, page(filterRows(rows as readonly Record<string, unknown>[], query), query));
    }
    if (parsed.pathname === '/api/documents' && request.method === 'GET') return sendJson(response, 200, page(filterRows(wb.documentsList(), query), query));
    if (parsed.pathname === '/api/approvals' && request.method === 'GET' && query.get('history') === 'true') { const result = page(filterRows(wb.approvals(), query), query); return sendJson(response, 200, { ...result, approvals: result.items }); }
    const recovery = /^\/api\/sessions\/([a-f0-9-]+)\/recovery-jobs\/([A-Za-z0-9_-]+)$/.exec(parsed.pathname);
    if (recovery) {
      const id = recovery[1]!, action = recovery[2]!;
      if (!wb.get(id)) return sendJson(response, 404, { message: 'Session not found.' });
      if (action === 'plan' && request.method === 'POST') return sendJson(response, 200, await wb.planRecoveryJob(id, await readJsonBody(request) as Parameters<Workbench['planRecoveryJob']>[1]));
      if (action === 'apply' && request.method === 'POST') return sendJson(response, 200, await wb.applyRecoveryJob(id, await readJsonBody(request) as Parameters<Workbench['applyRecoveryJob']>[1]));
      if (request.method === 'GET') return sendJson(response, 200, await wb.recoveryJobStatus(id, action));
      return sendJson(response, 405, { error: 'method_not_allowed' });
    }
    const feature = /^\/api\/sessions\/([a-f0-9-]+)\/(events|stream|documents|branches|compact)$/.exec(parsed.pathname);
    if (feature) {
      const id = feature[1]!, kind = feature[2], session = wb.get(id); if (!session) return sendJson(response, 404, { message: 'Session not found.' });
      if (kind === 'compact' && request.method === 'POST') { const compaction = wb.compact(id); return sendJson(response, 200, { compaction, session: wb.get(id) }); }
      if (kind === 'branches') {
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });
        let body: unknown;
        try { body = await readJsonBody(request); } catch { return sendJson(response, 400, { error: 'invalid_branch' }); }
        const input = parseBranchInput(body);
        if (!input) return sendJson(response, 400, { error: 'invalid_branch' });
        return sendJson(response, 201, { session: await wb.branch(id, input) });
      }
      if (kind === 'documents') {
        if (request.method === 'GET') return sendJson(response, 200, { document: wb.document(id, query.get('path') ?? '') });
        if (request.method === 'PATCH') return sendJson(response, 200, { document: await wb.editDocument(id, await readJsonBody(request) as { path: string; content: string; expectedRevision: string | null }) });
      }
      if (kind === 'events' && request.method === 'GET') { const items = session.events.filter(e => e.seq > Number(query.get('after') || 0)); return sendJson(response, 200, { items, after: items.at(-1)?.seq ?? Number(query.get('after') || 0), status: session.status, asOf: new Date().toISOString(), scope: id, historyComplete: session.events[0]?.seq === 1 }); }
      if (kind === 'stream' && request.method === 'GET') {
        if (activeStreams.has(id))
          return sendJson(response, CONTROL_PLANE_SSE_STREAM_IN_USE_STATUS, { error: 'session_stream_in_use', message: 'Another subscriber is already streaming this session.' });
        const stream = new SessionStream(response, id);
        activeStreams.set(id, stream);
        stream.start(wb, id, Number(request.headers['last-event-id'] ?? query.get('after') ?? 0));
        return;
      }
    }
  } catch (error) { return sendJson(response, 409, { message: error instanceof Error ? error.message : 'Request failed.' }); }
  if (parsed.pathname === "/api/provider") {
    try {
      if (request.method === "GET") return sendJson(response, 200, await options.workbench.providerState());
      if (request.method === "DELETE") { options.workbench.clearProvider(); return sendJson(response, 200, { ok: true }); }
      if (request.method === "POST") {
        const body = await readJsonBody(request) as { baseUrl?: string; apiKey?: string; kind?: string } | null;
        const { baseUrl, apiKey, kind } = body ?? {};
        if (typeof baseUrl !== "string" || typeof apiKey !== "string") return sendJson(response, 400, { error: "invalid_provider" });
        const models = await options.workbench.configure(normalizeProviderConfig({ baseUrl, apiKey, kind }));
        return sendJson(response, 200, { connected: true, models, keyStorage: "encrypted-local" });
      }
    } catch (error) { return sendJson(response, 400, { error: "provider_unavailable", message: error instanceof Error ? error.message : "Provider unavailable" }); }
  }
  if (parsed.pathname === '/api/connectors') {
    try {
      if (request.method === 'GET') return sendJson(response, 200, options.workbench.connectionState());
      if (request.method === 'POST') {
        const body = await readJsonBody(request) as { url: string; name?: string; token?: string; policy?: string; facts?: Record<string, boolean | string>; mapping?: Record<string, string> };
        return sendJson(response, 200, await options.workbench.addConnector(body));
      }
    } catch (error) { return sendJson(response, 400, { message: error instanceof Error ? error.message : 'Connector unavailable.' }); }
  }
  const connectorMatch = /^\/api\/connectors\/([a-f0-9-]+)$/.exec(parsed.pathname);
  if (connectorMatch && request.method === 'PATCH') { try { return sendJson(response, 200, { connector: await options.workbench.updateConnector(connectorMatch[1]!, await readJsonBody(request) as Record<string, unknown>) }); } catch(error) { return sendJson(response, 409, { message: error instanceof Error ? error.message : 'Connector update failed.' }); } }
  const connectorTest = /^\/api\/connectors\/([a-f0-9-]+)\/test$/.exec(parsed.pathname);
  if (connectorTest && request.method === 'POST') { try { return sendJson(response, 200, await options.workbench.testConnector(connectorTest[1]!)); } catch(error) { return sendJson(response, 400, { message: error instanceof Error ? error.message : 'Connector test failed.' }); } }
  if (connectorMatch && request.method === 'DELETE') { options.workbench.removeConnector(connectorMatch[1]!); return sendJson(response, 200, { ok: true }); }
  const workspaceMatch = /^\/api\/sessions\/([a-f0-9-]+)\/(workspace|undo)(?:\/([A-Za-z0-9_.:-]+))?$/.exec(parsed.pathname);
  if (workspaceMatch) {
    try {
      const id = workspaceMatch[1]!, operation = workspaceMatch[3]!;
      if (workspaceMatch[2] === 'workspace' && request.method === 'GET') return sendJson(response, 200, { workspace: options.workbench.workspace(id) });
      if (workspaceMatch[2] === 'undo' && request.method === 'GET') return sendJson(response, 200, await options.workbench.undoPreview(id, operation));
      if (workspaceMatch[2] === 'undo' && request.method === 'POST') {
        const body = await readJsonBody(request) as { confirm?: string };
        if (body.confirm !== operation) return sendJson(response, 409, { message: 'Preview and confirm this change first.' });
        return sendJson(response, 200, await options.workbench.undo(id, operation));
      }
    } catch (error) { return sendJson(response, 409, { message: error instanceof Error ? error.message : 'Workspace operation failed.' }); }
  }
  if (request.method === 'GET' && ['/api/feed', '/api/ledger/verify', '/api/ledger/export'].includes(parsed.pathname)) {
    const workspace = parsed.searchParams.get('workspace') || options.workbench.list().at(-1)?.workspace;
    // The workbench verifies this chain against the key it resolved, and
    // throws when it cannot authenticate one. An unauthenticatable chain is a
    // shaped refusal, not a server fault: catch it and fall through to the
    // handlers below, which report the same failure the other callers get
    // instead of an unhandled 500.
    const proof = workspace
      ? await options.workbench.ledger(workspace).catch(() => undefined)
      : undefined;
    if (proof && proof.entries.length) {
      // `signed: true` here is earned, not defaulted: `Workbench.ledger`
      // verified this chain with the key it resolved and throws otherwise, so
      // reaching this line means a signature check passed. What that check is
      // *worth* is not the same claim, which is why the `verificationKey` block
      // travels with every one of these responses and carries
      // `substitutionDetected` alongside `authenticated`. A client that reads
      // only the boolean calls a trust-file check tamper-proofing, which it is
      // not.
      const verification = verificationSummary(proof.verification);
      if (parsed.pathname === '/api/feed') { const result = page(filterRows(proof.entries.map(e => ({ seq: e.seq, ...(e.body as JsonObject), hash: e.hash, digest: e.hash, prev_hash: e.prev_hash })).reverse(), query), query, workspace); return sendJson(response, 200, { ...result, entries: result.items, verified: true, signed: true, substitutionDetected: verification["substitutionDetected"] === true, integrity: true, checked: proof.entries.length, verificationKey: verification }); }
      if (parsed.pathname === '/api/ledger/verify') return sendJson(response, 200, { ok: true, verified: true, signed: true, substitutionDetected: verification["substitutionDetected"] === true, integrity: true, checked: proof.entries.length, head: proof.result.head, verificationKey: verification });
      response.setHeader('content-disposition', 'attachment; filename="void-ledger.json"');
      // A bundle without the key that authenticated it is silently
      // unverifiable downstream, so the verification block travels with it.
      return sendJson(response, 200, { format: 'void.signed-ledger.v1', entries: proof.entries, checked: proof.entries.length, head: proof.result.head, verificationKey: verification });
    }
  }
  if (parsed.pathname === "/api/sessions") {
    if (request.method === "GET") return sendJson(response, 200, options.workbench.sessionPage(query));
    if (request.method === "POST") {
      const body = await readJsonBody(request) as { prompt?: string; model?: string; project?: string; agent?: string; background?: boolean; idempotencyKey?: string } | null;
      if (typeof body?.prompt !== "string" || (body.model !== undefined && typeof body.model !== "string") || (body.project !== undefined && typeof body.project !== "string") || (body.agent !== undefined && typeof body.agent !== "string") || (body.background !== undefined && typeof body.background !== "boolean")) return sendJson(response, 400, { error: "invalid_session" });
      try {
        const session = await options.workbench.start(body.prompt, body.model, body.idempotencyKey, body.project, body.agent, body.background);
        options.fleetEvents.record({ kind: "run_started", agentId: session.id, sessionId: session.id, label: "run started for session" });
        return sendJson(response, 201, { session });
      }
      catch (error) { return sendJson(response, 409, { error: "session_not_started", message: error instanceof Error ? error.message : "Session not started" }); }
    }
  }
  const sessionMatch = /^\/api\/sessions\/([a-f0-9-]+)$/.exec(parsed.pathname);
  if (sessionMatch) {
    const id = sessionMatch[1]!;
    const session = options.workbench.get(id);
    if (!session) return sendJson(response, 404, { error: "session_not_found" });
    if (request.method === "PATCH") { try { return sendJson(response, 200, { session: wb.patchSession(id, await readJsonBody(request) as Record<string, unknown>) }); } catch (error) { return sendJson(response, 400, { message: error instanceof Error ? error.message : "Invalid update." }); } }
    if (request.method === "GET") return sendJson(response, 200, { session: query.get("events") === "false" ? { ...session, events: [] } : session });
    if (request.method === "DELETE") { options.workbench.cancel(id); return sendJson(response, 200, { ok: true }); }
    if (request.method === "POST") {
      const body = await readJsonBody(request) as { prompt?: string; idempotencyKey?: string } | null;
      if (typeof body?.prompt !== "string") return sendJson(response, 400, { error: "invalid_message" });
      try { options.workbench.send(id, body.prompt, body.idempotencyKey); return sendJson(response, 202, { ok: true }); }
      catch (error) { return sendJson(response, 409, { error: "session_not_ready", message: error instanceof Error ? error.message : "Session not ready" }); }
    }
  }
  const recordAction = /^\/api\/records\/(\d+)\/(taint|replay)$/.exec(parsed.pathname);
  if (recordAction && (request.method === "GET" || request.method === "POST")) {
    const seq = Number(recordAction[1]);
    const workspace = parsed.searchParams.get('workspace') || options.workbench.list().at(-1)?.workspace;
    const managed = workspace ? options.workbench.list().find(s => s.workspace === workspace) : undefined;
    const proof = managed ? await options.workbench.ledger(managed.workspace) : undefined;
    if (managed && proof?.entries.length) {
      const entry = proof.entries.find(e => e.seq === seq);
      if (!entry) return sendJson(response, 404, { message: 'Record not found.' });
      if (recordAction[2] === 'taint') return sendJson(response, 200, { ...neighbors(buildGraph(proof.entries), entry.hash, 8), note: DATA_EDGE_HONESTY_NOTE, signed: true });
      const operationId = (entry.body as JsonObject).operationId;
      if (typeof operationId !== 'string') return sendJson(response, 409, { message: 'This call has no captured document inverse.' });
      try {
        const preview = await options.workbench.undoPreview(managed.id, operationId);
        if (request.method === 'POST') {
          const body = await readJsonBody(request) as { digest?: string };
          if (body.digest !== entry.hash) return sendJson(response, 409, { message: 'Preview this exact record first.' });
          await options.workbench.undo(managed.id, operationId);
        }
        return sendJson(response, 200, { digest: entry.hash, canApply: preview.canApply, lines: [preview.path, preview.reason ?? 'Captured inverse verified.', `Current:\n${preview.before ?? '(absent)'}`, `After Undo:\n${preview.after ?? '(absent)'}`, ...(request.method === 'POST' ? ['Undo applied.'] : [])] });
      } catch (error) { return sendJson(response, 409, { message: error instanceof Error ? error.message : 'Undo refused.' }); }
    }
    const ledger = selectLedgerPath(options, parsed.searchParams.get("workspace"));
    if (!ledger || !Number.isSafeInteger(seq) || seq < 1) return sendJson(response, 400, { error: "invalid_record" });
    const entries = await readLedgerEntries(ledger);
    const verified = await verifyChain(entries, { publicKey: options.publicKey });
    if (!verified.ok) return sendJson(response, 409, { error: "ledger_verification_failed" });
    const entry = entries.find(item => item.seq === seq);
    if (!entry) return sendJson(response, 404, { error: "record_not_found" });
    if (recordAction[2] === "taint" && request.method === "GET") {
      const graph = neighbors(buildGraph(entries), entry.hash, 8);
      return sendJson(response, 200, { ...graph, note: DATA_EDGE_HONESTY_NOTE, signed: options.publicKey !== undefined });
    }
    if (recordAction[2] === "replay") {
      const apply = request.method === "POST";
      if (apply) {
        const body = await readJsonBody(request) as { digest?: string } | null;
        if (body?.digest !== entry.hash) return sendJson(response, 409, { error: "preview_digest_required" });
        if (!options.publicKey) return sendJson(response, 409, { error: "signature_key_required", message: "Replay requires verified signatures." });
      }
      const snapshots = options.env.VOID_SNAPSHOT_DIR;
      if (!snapshots) return sendJson(response, 409, { error: "snapshots_not_configured", message: "Set VOID_SNAPSHOT_DIR on the runtime to preview captured inverses." });
      const lines: string[] = [];
      const errors: string[] = [];
      const code = await runReplayCommand(["--ledger", ledger, "--snapshot-dir", snapshots, "--seq", String(seq), ...(apply ? [] : ["--dry-run"])], { stdout: line => lines.push(line), stderr: line => errors.push(line), env: options.env }, options.replay);
      return sendJson(response, code === 0 ? 200 : 409, { ok: code === 0, digest: entry.hash, preview: !apply, lines, message: errors.join("\n") });
    }
  }
  if (request.method === "GET" && parsed.pathname === "/api/ledger/export") {
    const ledger = selectLedgerPath(options, parsed.searchParams.get("workspace"));
    if (!ledger) return sendJson(response, 400, { error: "invalid_workspace" });
    // Same shape as the workbench-backed export above: a bundle that does not
    // carry the key that authenticated it cannot be re-verified downstream.
    const page = await readLedgerFeed(ledger, { publicKey: options.publicKey }).catch(() => undefined);
    response.setHeader("content-disposition", 'attachment; filename="void-records.json"');
    if (page === undefined)
      return sendJson(response, 200, {
        format: "void.signed-ledger.v1",
        verified: false,
        signed: false,
        integrity: false,
        checked: 0,
        entries: [],
        verificationKey: verificationSummary(options.verificationKey),
        reason: "Ledger integrity or signature validation failed. Inspect the ledger locally before trusting these records.",
      });
    const verification = verificationSummary(options.verificationKey);
    return sendJson(response, 200, {
      format: "void.signed-ledger.v1",
      verified: page.signed,
      signed: page.signed,
      substitutionDetected: verification["substitutionDetected"] === true,
      integrity: true,
      checked: page.records.length,
      head: page.head,
      verificationKey: verification,
      entries: await readLedgerEntries(ledger),
    });
  }
  if (request.method === "GET" && parsed.pathname === "/api/feed") {
    return handleFeed(response, options, parsed.searchParams);
  }
  if (request.method === "GET" && parsed.pathname === "/api/fleet/events") {
    const after = Number(query.get("after") ?? 0);
    const events = Number.isFinite(after) ? options.fleetEvents.after(after) : [];
    return sendJson(response, 200, {
      items: events,
      after: events.at(-1)?.seq ?? after,
      stopAck: options.fleetEvents.stopAck(query.get("sessionId") ?? undefined),
      asOf: new Date().toISOString(),
      // Honest scope note for the operator: these events describe this
      // process only; a killed child's final state is not observable here.
      scope: "this process only",
    });
  }
  if (request.method === "GET" && parsed.pathname === "/api/ledger/verify") {
    return handleVerify(response, options, parsed.searchParams);
  }
  if (request.method === "GET" && parsed.pathname === "/api/approvals") {
    return handleApprovals(response, options.approvals);
  }
  const approvalMatch = /^\/api\/approvals\/([^/]+)\/decision$/.exec(parsed.pathname);
  if (request.method === "POST" && approvalMatch !== null) {
    return handleApprovalDecision(request, response, options.approvals, decodeURIComponent(approvalMatch[1]!), options.fleetEvents);
  }
  if (parsed.pathname === "/api/companion/envelope") {
    // The envelope adapter speaks the frozen `void.companion.v1` wire contract
    // on one path. It is mounted inside the existing companion prefix so it
    // keeps the same host or loopback gate and cross-site protections as every
    // other API path, and proves its own device credential per request.
    return handleCompanionEnvelopeRequest(request, response, options.env);
  }
  if (parsed.pathname === "/api/companion/devices" || parsed.pathname.startsWith("/api/companion/")) {
    // Device routes keep the same host or loopback gate as every other API
    // path and add their own per-request device credential inside.
    return handleCompanionRequest(request, response, options.env);
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return serveStatic(request, response, options.webRoot, parsed.pathname);
  }
  sendJson(response, 404, { error: "not_found" });
}

/**
 * Which key this response was verified with, in one shape for every endpoint.
 *
 * `authenticated` is the boolean a client should branch on, and it is the only
 * one that means "a public key checked these signatures". `degraded` means
 * private key material was involved, and `operatorSupplied` means the operator
 * chose these bytes somewhere the agent cannot reach. With no key at all,
 * `degraded` is reported as true: the honest value would be a third state, and
 * emitting `degraded: false` beside `source: "none"` invites a client to
 * read the absence of a key as an absence of degradation. Over-reporting
 * degradation is the safe direction; `authenticated: false` disambiguates it.
 *
 * `authenticated` is deliberately *not* the same claim as `substitutionDetected`.
 * A signature can check out against a trust file the agent can also replace,
 * and a client that only reads `authenticated: true` would call that
 * tamper-proofing. The two fields say different things and both are present.
 */
function verificationSummary(key: VerificationFacts | undefined): JsonObject {
  if (!key)
    return {
      keyId: null,
      source: "none",
      authenticated: false,
      substitutionDetected: false,
      degraded: true,
      note: NO_VERIFICATION_KEY_NOTE,
    };
  const note = verificationKeyNote(key);
  return {
    keyId: key.keyId,
    source: key.source,
    authenticated: true,
    // True only for a key the operator supplied where the agent cannot reach.
    // A trust file at any path is inferred from the path alone, so it never
    // earns this, and the default path in particular shares a tree with the
    // signing key.
    substitutionDetected: key.operatorSupplied && !key.degraded,
    degraded: key.degraded,
    operatorSupplied: key.operatorSupplied,
    ...(note !== undefined ? { note } : {}),
  };
}

async function handleFeed(response: ServerResponse, options: RouteOptions, searchParams: URLSearchParams): Promise<void> {
  const ledgerPath = selectLedgerPath(options, searchParams.get("workspace"));
  if (ledgerPath === null) return sendJson(response, 400, { error: "invalid_workspace" });
  try { await stat(ledgerPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A missing ledger means no calls were recorded yet. That is a valid
      // empty state with the same page shape, not a failed request.
      const fresh = searchParams.get("workspace") ?? options.env.VOID_WORKSPACE ?? basename(ledgerPath, ".jsonl");
      const empty = page(filterRows([], searchParams), searchParams, fresh);
      return sendJson(response, 200, { ...empty, entries: empty.items, verified: false, signed: false, integrity: false, checked: 0, message: "No recorded calls yet. Start an agent session or connect an existing VOID workspace." });
    }
    throw error;
  }
  const workspace = searchParams.get("workspace") ?? options.env.VOID_WORKSPACE ?? basename(ledgerPath, ".jsonl");
  let feed: Awaited<ReturnType<typeof readLedgerFeed>>;
  try {
    feed = await readLedgerFeed(ledgerPath, { publicKey: options.publicKey });
  } catch {
    // A chain that cannot be authenticated is a refusal with a shape, not a
    // server fault. The rows are withheld because nothing vouches for them.
    const refused = page(filterRows([], searchParams), searchParams, workspace);
    return sendJson(response, 200, {
      ...refused,
      entries: [],
      verified: false,
      integrity: false,
      signed: false,
      checked: 0,
      verificationKey: verificationSummary(options.verificationKey),
      reason: "Ledger integrity or signature validation failed. Inspect the ledger locally before trusting these records.",
    });
  }
  const rows = feed.records.map(record => ({ ...toApiEntry(record), workspace })).reverse();
  const result = page(filterRows(rows, searchParams), searchParams, workspace);
  const verification = verificationSummary(options.verificationKey);
  sendJson(response, 200, { ...result, entries: result.items, verified: feed.signed, integrity: true, signed: feed.signed, substitutionDetected: verification["substitutionDetected"] === true, checked: feed.records.length, verificationKey: verification });
}

async function handleVerify(response: ServerResponse, options: RouteOptions, searchParams: URLSearchParams): Promise<void> {
  const ledgerPath = selectLedgerPath(options, searchParams.get("workspace"));
  if (ledgerPath === null) return sendJson(response, 400, { error: "invalid_workspace" });
  try {
    const page = await readLedgerFeed(ledgerPath, { publicKey: options.publicKey });
    const verification = verificationSummary(options.verificationKey);
    sendJson(response, 200, {
      verificationKey: verification,
      ok: true,
      verified: page.signed,
      integrity: true,
      signed: page.signed,
      substitutionDetected: verification["substitutionDetected"] === true,
      checked: page.records.length,
      head: page.head,
    });
  } catch (error) {
    sendJson(response, 200, {
      setup: (error as NodeJS.ErrnoException).code === "ENOENT",
      ok: false,
      verified: false,
      integrity: false,
      signed: false,
      checked: 0,
      head: GENESIS_PREV,
      verificationKey: verificationSummary(options.verificationKey),
      reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "No ledger yet. Run an agent through void-proxy in this workspace, then refresh." : "Ledger integrity or signature validation failed. Inspect the ledger locally before trusting these records.",
    });
  }
}

async function handleApprovals(response: ServerResponse, approvals: ApprovalBroker | undefined): Promise<void> {
  const pending = await readPendingApprovals(approvals);
  sendJson(response, 200, { approvals: pending.map(toApiApproval) });
}

async function handleApprovalDecision(
  request: IncomingMessage,
  response: ServerResponse,
  approvals: ApprovalBroker | undefined,
  holdId: string,
  fleetEvents: FleetEventStore,
): Promise<void> {
  if (approvals === undefined) {
    return sendJson(response, 503, {
      error: "approvals_not_wired",
      message: "ApprovalBroker is not wired into this server yet",
    });
  }

  const body = await readJsonBody(request);
  const decision = parseDecision(body);
  if (decision === null) return sendJson(response, 400, { error: "invalid_decision" });
  const result = await approvals.decide(holdId, decision);
  response.setHeader("cache-control", "no-store");
  if (result === false)
    return sendJson(response, 409, { error: "approval_not_accepted" });
  fleetEvents.record({ kind: "approval", agentId: holdId, sessionId: undefined, label: "approval decided", verdict: decision.kind });
  sendJson(response, 200, { ok: true, result });
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  webRoot: string,
  pathname: string,
): Promise<void> {
  const filePath = staticPath(webRoot, pathname);
  if (filePath === null) return sendJson(response, 404, { error: "not_found" });
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return sendJson(response, 404, { error: "not_found" });
  } catch {
    return sendJson(response, 404, { error: "not_found" });
  }
  response.statusCode = 200;
  response.setHeader("content-type", contentType(filePath));
  response.setHeader("cache-control", filePath.endsWith(".html") ? "no-store" : "public, max-age=0, must-revalidate");
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await new Promise<void>((resolvePipe, rejectPipe) => {
    const stream = createReadStream(filePath);
    stream.once("error", rejectPipe);
    response.once("error", rejectPipe);
    response.once("finish", resolvePipe);
    stream.pipe(response);
  });
}

function toApiEntry(record: LedgerFeedRecord): JsonObject {
  return {
    seq: record.seq,
    at: record.at,
    tool: record.tool,
    klass: record.klass,
    decision: record.decision,
    argsDigest: record.argsDigest,
    prev_hash: record.prevDigest,
    hash: record.digest,
    digest: record.digest,
    // A record that carries no reason must not acquire a null one here: the
    // absence is the fact, and a consumer that reads null learns nothing
    // about whether this entry predates attribution or merely has no rule.
    ...(record.attribution === undefined ? {} : { attribution: record.attribution }),
  };
}

function toApiApproval(record: PendingApproval): JsonObject {
  return {
    holdId: record.holdId,
    call: record.call,
    ...(record.binding === undefined ? {} : { binding: record.binding }),
    ...(record.operationSummary === undefined ? {} : { operationSummary: record.operationSummary }),
    expiresAt: record.expiresAt,
    status: record.status,
  };
}

// Host validation blocks DNS rebinding; Origin and Fetch Metadata block hostile
// browser pages. This is a local boundary, not authentication between local users.
function isLocalRequest(request: IncomingMessage): boolean {
  const peer = request.socket.remoteAddress;
  if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return false;
  const port = request.socket.localPort;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const host = request.headers.host;
  if (host === undefined || !hosts.has(host)) return false;
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

function parseRequestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    return null;
  }
}

function parseLimit(raw: string | null): number {
  if (raw === null) return 50;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 200);
}

async function readPendingApprovals(approvals: ApprovalBroker | undefined): Promise<readonly PendingApproval[]> {
  const pending = approvals?.listPending !== undefined
    ? await approvals.listPending()
    : approvals?.pending !== undefined
      ? await approvals.pending()
      : [];
  return pending.map((record) => {
    const operationSummary = record.operationSummary ?? approvals?.review?.(record.holdId)?.summary;
    return operationSummary === undefined ? record : { ...record, operationSummary };
  });
}

function parseDecision(value: unknown): ApprovalDecision | null {
  if (typeof value !== "object" || value === null) return null;
  const body = value as Record<string, unknown>;

  if (body.kind !== "approved" && body.kind !== "denied") return null;
  if (typeof body.by !== "string" || body.by === "") return null;
  if (body.reason !== undefined && typeof body.reason !== "string") return null;
  return body.reason === undefined
    ? { kind: body.kind, by: body.by }
    : { kind: body.kind, by: body.by, reason: body.reason };
}

function parseBranchInput(value: unknown): { seq: number; prompt?: string; snapshotDocuments?: boolean; idempotencyKey: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed: Record<string, true> = { seq: true, prompt: true, snapshotDocuments: true, idempotencyKey: true };
  if (Object.keys(body).some((key) => !allowed[key])) return null;
  if (!Number.isSafeInteger(body.seq) || (body.seq as number) < 1) return null;
  if (body.prompt !== undefined &&
    (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 32000 || body.prompt.includes("\0"))) return null;
  if (body.snapshotDocuments !== undefined && typeof body.snapshotDocuments !== "boolean") return null;
  if (typeof body.idempotencyKey !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(body.idempotencyKey)) return null;
  return {
    seq: body.seq as number,
    ...(body.prompt === undefined ? {} : { prompt: body.prompt as string }),
    ...(body.snapshotDocuments === undefined ? {} : { snapshotDocuments: body.snapshotDocuments as boolean }),
    idempotencyKey: body.idempotencyKey,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  // Browsers block cross-origin application/json form posts behind a preflight,
  // but a text/plain form body can still be crafted to parse as JSON. Requiring
  // the explicit content type keeps the decision endpoint a fetch-only surface,
  // so a hostile page cannot post a decision through a victim browser session.
  const contentType = request.headers["content-type"];
  if (contentType === undefined || !applicationJsonContentType(contentType)) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error("request body exceeds 64 KiB");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function applicationJsonContentType(header: string): boolean {
  const [mediaType] = header.split(";", 2);
  return mediaType.trim().toLowerCase() === "application/json";
}

function sendJson(response: ServerResponse, statusCode: number, value: JsonObject): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function staticPath(webRoot: string, pathname: string): string | null {
  if (pathname.startsWith('/api/')) return null;
  const spa = /^\/(chat(?:\/[^/]*)?|demo|overview|sessions|runs|documents|approvals|ledger|connections|models|settings|gallery)$/.test(pathname);
  const legacySpa = ['/feed.html','/approvals.html','/ledger.html'].includes(pathname) && !existsSync(join(webRoot, pathname));
  const name = pathname === '/' || spa || legacySpa ? '/index.html' : pathname;
  let normalized: string;
  try {
    const decoded = decodeURIComponent(name);
    if (decoded.includes("\\") || decoded.includes("\0")) return null;
    // URL paths use forward slashes even when the host filesystem is Windows.
    normalized = posix.normalize(decoded);
  } catch {
    return null;
  }
  if (!normalized.endsWith(".html") && !publicScriptPaths.has(normalized) && !/^\/assets\/[A-Za-z0-9_.-]+\.(js|css|svg|woff2)$/.test(normalized)) return null;
  const target = resolve(join(webRoot, normalized));
  const inside = relative(webRoot, target);
  if (inside.startsWith("..") || inside === "" || inside.includes(":") || resolve(webRoot, inside) !== target) return null;
  return target;
}

function contentType(filePath: string): string {
  if (extname(filePath) === ".html") return "text/html; charset=utf-8";
  if (extname(filePath) === ".webmanifest") return "application/manifest+json";
  if (extname(filePath) === ".svg") return "image/svg+xml";
  if (extname(filePath) === ".css") return "text/css; charset=utf-8";
  if (extname(filePath) === ".js") return "application/javascript; charset=utf-8";
  return "application/octet-stream";
}

function selectLedgerPath(options: RouteOptions, workspace: string | null): string | null {
  if (options.ledgerPath !== undefined) return options.ledgerPath;
  const name = workspace ?? options.env.VOID_WORKSPACE ?? "default";
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const dir = options.env.VOID_LEDGER_DIR ?? join(homedir(), ".void", "ledger");
  return join(dir, `${name}.jsonl`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? "8081", 10);
  createControlPlaneServer({ approvals: localApprovals(process.env) }).listen(port, process.env.VOID_CONTROL_TOKEN && process.env.VOID_CONTROL_TOKEN.length >= 32 ? process.env.VOID_CONTROL_HOST ?? "127.0.0.1" : "127.0.0.1", () => {
    console.log(`VOID control plane API listening on http://127.0.0.1:${port}`);
  });
}

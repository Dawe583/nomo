import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

export const LOCAL_AGENT_GRANT_ISSUER = "nomo-workbench-local";
export const LOCAL_AGENT_GRANT_AUDIENCE = "nomo-inbound-proxy";
export const LOCAL_AGENT_PRINCIPAL_ID = "workbench-local";
export const LOCAL_AGENT_GRANT_TTL_MS = 60_000;

export type LocalAgentGrantBinding = Readonly<{
  principalId: string;
  workspaceId: string;
  agentId: string;
  runId: string;
  upstreamId: string;
  toolScope: readonly string[];
}>;

export type LocalAgentGrantAuthenticationRequest = Readonly<{
  audience: string;
  upstreamId: string;
}>;

export type LocalAgentGrantRequest = Readonly<{
  audience: string;
  upstreamId: string;
  toolName: string;
}>;

export type LocalAgentIdentity = LocalAgentGrantBinding &
  Readonly<{
    issuer: string;
    audience: string;
    issuedAt: number;
    expiresAt: number;
  }>;

export type IssuedLocalAgentGrant = Readonly<{
  token: string;
  expiresAt: number;
}>;

type GrantRecord = Readonly<{
  identity: LocalAgentIdentity;
  expiresAtMonotonic: number;
}>;

type ClockReading = Readonly<{ monotonic: number; wall: number }>;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_SCOPE_SIZE = 256;

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function canonicalToolScope(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPE_SIZE)
    throw new TypeError("Invalid local agent tool scope");
  const scope: string[] = [];
  for (const toolName of value) {
    if (!validIdentifier(toolName) || toolName.length > 128)
      throw new TypeError("Invalid local agent tool scope");
    scope.push(toolName);
  }
  if (new Set(scope).size !== scope.length)
    throw new TypeError("Invalid local agent tool scope");
  return Object.freeze(scope.sort());
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class LocalAgentIdentityIssuer {
  readonly #monotonicNow: () => number;
  readonly #wallNow: () => number;
  readonly #grantsByDigest = new Map<string, GrantRecord>();
  readonly #digestByRun = new Map<string, string>();
  #lastMonotonicNow = Number.NEGATIVE_INFINITY;
  #lastWallNow = Number.NEGATIVE_INFINITY;

  constructor(
    options: { now?: () => number; wallNow?: () => number } = {},
  ) {
    this.#monotonicNow = options.now ?? (() => performance.now());
    this.#wallNow = options.wallNow ?? Date.now;
  }

  issue(binding: LocalAgentGrantBinding): IssuedLocalAgentGrant {
    if (
      !binding ||
      !validIdentifier(binding.principalId) ||
      !validIdentifier(binding.workspaceId) ||
      !validIdentifier(binding.agentId) ||
      !validIdentifier(binding.runId) ||
      !validIdentifier(binding.upstreamId)
    ) {
      throw new TypeError("Invalid local agent identity binding");
    }

    const toolScope = canonicalToolScope(binding.toolScope);
    const now = this.#readNow();
    if (now === null) throw new Error("Local agent grant clock is invalid");
    const issuedAt = now.wall;
    const expiresAt = issuedAt + LOCAL_AGENT_GRANT_TTL_MS;
    const token = randomBytes(32).toString("base64url");
    const digest = tokenDigest(token);

    this.#dropRun(binding.runId);
    const identity: LocalAgentIdentity = Object.freeze({
      principalId: binding.principalId,
      workspaceId: binding.workspaceId,
      agentId: binding.agentId,
      runId: binding.runId,
      upstreamId: binding.upstreamId,
      toolScope,
      issuer: LOCAL_AGENT_GRANT_ISSUER,
      audience: LOCAL_AGENT_GRANT_AUDIENCE,
      issuedAt,
      expiresAt,
    });
    this.#grantsByDigest.set(digest, {
      identity,
      expiresAtMonotonic: now.monotonic + LOCAL_AGENT_GRANT_TTL_MS,
    });
    this.#digestByRun.set(binding.runId, digest);
    return Object.freeze({ token, expiresAt });
  }

  authenticate(
    token: string,
    request: LocalAgentGrantAuthenticationRequest,
  ): LocalAgentIdentity | null {
    const now = this.#readNow();
    if (
      now === null ||
      typeof token !== "string" ||
      !TOKEN_PATTERN.test(token) ||
      !request ||
      request.audience !== LOCAL_AGENT_GRANT_AUDIENCE ||
      !validIdentifier(request.upstreamId)
    ) {
      return null;
    }

    const digest = tokenDigest(token);
    const record = this.#grantsByDigest.get(digest);
    if (!record) return null;
    const { identity } = record;
    const expired =
      now.monotonic >= record.expiresAtMonotonic || now.wall >= identity.expiresAt;
    if (expired || request.upstreamId !== identity.upstreamId) {
      if (expired) this.#dropRun(identity.runId);
      return null;
    }

    return Object.freeze({
      ...identity,
      toolScope: Object.freeze([...identity.toolScope]),
    });
  }

  validate(
    token: string,
    request: LocalAgentGrantRequest,
  ): LocalAgentIdentity | null {
    if (!request || !validIdentifier(request.toolName)) return null;
    const identity = this.authenticate(token, request);
    return identity?.toolScope.includes(request.toolName) ? identity : null;
  }

  revoke(runId: string): boolean {
    return this.#dropRun(runId);
  }

  #readNow(): ClockReading | null {
    let monotonic: number;
    let wall: number;
    try {
      monotonic = this.#monotonicNow();
      wall = this.#wallNow();
    } catch {
      return null;
    }
    if (
      !Number.isFinite(monotonic) ||
      !Number.isFinite(wall) ||
      monotonic < this.#lastMonotonicNow ||
      wall < this.#lastWallNow
    ) {
      return null;
    }
    this.#lastMonotonicNow = monotonic;
    this.#lastWallNow = wall;
    return { monotonic, wall };
  }

  #dropRun(runId: string): boolean {
    const digest = this.#digestByRun.get(runId);
    if (!digest) return false;
    this.#digestByRun.delete(runId);
    this.#grantsByDigest.delete(digest);
    return true;
  }
}

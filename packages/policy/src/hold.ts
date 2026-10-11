/**
 * The blocking hold, WP-05. A held tool call blocks its MCP response until
 * a human resolves it or the timer runs out.
 *
 * The design constraint is the MCP error on cancel: if the release is a
 * generic error, the agent retries, sometimes with a slightly different
 * statement, and the tool has trained the agent to evade it. So a denied
 * release names the rule, the class, and what approval would look like,
 * in a body the model can read, and an expired hold says so plainly
 * instead of posing as a transport failure.
 */

import { userInfo } from "node:os";

import type { Decision } from "./grammar.ts";

export type HoldId = string;

/** The immutable context that a local operator approves for one held call. */
export type HoldBinding = Readonly<{
  operationId: string;
  operationDigest: string;
  policyVersion: number;
  policyDigest: string;
  operatorId: string;
  principalId: string;
  agentId: string;
  runId: string;
  workspaceId: string;
  upstreamId: string;
  schemaDigest: string;
}>;

/** Identifies the OS account running the local approval authority. */
export function verifiedLocalOperatorId(): string {
  const uid = process.getuid?.();
  if (typeof uid === "number") return `uid:${uid}`;
  const username = userInfo().username.trim();
  if (username === "") throw new Error("local operator identity is unavailable");
  return `user:${username}`;
}

/** In-process request state; use reviewableHeldCall for human-facing surfaces. */
export type HeldCall = {
  readonly id: HoldId;
  /** Registry entry id. */
  readonly tool: string;
  /** The reversibility class the call was given. */
  readonly klass: string;
  /** Rows, files or objects the call would touch. */
  readonly blastRadius: number | undefined;
  /** The rule index that held it, and its stated reason. */
  readonly ruleIndex: number;
  readonly rationale: string | undefined;
  /** Raw arguments stay in process; approval surfaces receive only a redacted summary. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly heldAt: number;
  readonly expiresAt: number;
  readonly notify: readonly string[];
  readonly binding?: HoldBinding;
};

export type ReviewableHeldCall = Omit<HeldCall, "args"> & {
  readonly summary: string;
};

const SECRET_REVIEW_KEYS = [
  "apikey",
  "authorization",
  "authheader",
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "privatekey",
  "accesskey",
  "clientsecret",
  "cookie",
  "prompt",
  "message",
  "content",
  "session",
  "signature",
  "signedurl",
];
const SECRET_REVIEW_VALUE = /\b(?:bearer\s+[A-Za-z0-9._~+/-]+|(?:sk|rk|pk|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b|(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/i;
export const MAX_OPERATION_SUMMARY_LENGTH = 1_000;

/** Build a bounded, redacted summary without retaining raw arguments in approval records. */
export function safeOperationSummary(args: Readonly<Record<string, unknown>>): string {
  const summary = JSON.stringify(redactReviewValue(args, "", 0)) ?? "{}";
  return summary.length <= MAX_OPERATION_SUMMARY_LENGTH
    ? summary
    : `${summary.slice(0, MAX_OPERATION_SUMMARY_LENGTH - 3)}...`;
}

export function reviewableHeldCall(call: HeldCall): ReviewableHeldCall {
  const { args, ...details } = call;
  return { ...details, summary: safeOperationSummary(args) };
}

function redactReviewValue(value: unknown, key: string, depth: number): unknown {
  const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SECRET_REVIEW_KEYS.some((secretKey) => normalizedKey.includes(secretKey)))
    return "[redacted]";
  if (typeof value === "string") {
    if (SECRET_REVIEW_VALUE.test(value)) return "[redacted]";
    return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value !== "object") return "[unsupported]";
  if (depth >= 3) return "[nested]";
  if (Array.isArray(value)) {
    const selected = value.slice(0, 4).map((item) => redactReviewValue(item, "", depth + 1));
    if (value.length > 4) selected.push(`+${value.length - 4} more`);
    return selected;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  const visible: [string, unknown][] = entries.slice(0, 8).map(([childKey, childValue]) => [
    childKey.length <= 80 ? childKey : `${childKey.slice(0, 77)}...`,
    redactReviewValue(childValue, childKey, depth + 1),
  ]);
  if (entries.length > 8) visible.push(["...", `+${entries.length - 8} more`]);
  return Object.fromEntries(visible);
}

export type Release =
  | { readonly kind: "approved"; readonly by?: string }
  | { readonly kind: "denied"; readonly by: string };

export type HoldOutcome =
  | { readonly kind: "released"; readonly release: Release }
  | { readonly kind: "expired" }
  | { readonly kind: "cancelled" };

export type HoldResolution = {
  readonly id: HoldId;
  readonly outcome: HoldOutcome;
  readonly call: HeldCall;
};

/**
 * The error body a blocked agent reads. It is a plain object rather than a
 * string, because the model acts on structure: the rule it broke, the
 * class it was given, and the channel where a human decides.
 */
export function holdErrorMessage(
  call: HeldCall,
  outcome: HoldOutcome,
  decision: Decision,
): { code: number; message: string; data: Record<string, unknown> } {
  const expiry = outcome.kind === "expired";
  const cancelled = outcome.kind === "cancelled";
  const verb = expiry
    ? "expired without a human decision"
    : cancelled
      ? "was cancelled before dispatch"
      : outcome.release.kind === "approved"
        ? "was approved and released"
        : "was denied by a human";
  const message =
    `The call to ${call.tool} (${call.klass}, blast radius ${call.blastRadius ?? "unknown"}) ` +
    `${verb}. Rule ${call.ruleIndex} ${decision === "hold" ? "held" : "denied"} it` +
    (call.rationale === undefined ? "." : `: ${call.rationale}.`) +
    (outcome.kind === "released" && outcome.release.kind === "denied"
      ? ` Do not retry the same call; it was rejected by ${outcome.release.by}.`
      : "");
  return {
    code: expiry ? -32000 : cancelled ? -32800 : -32003,
    message,
    data: {
      held: call.tool,
      class: call.klass,
      blastRadius: call.blastRadius,
      rule: call.ruleIndex,
      result: expiry ? "expired" : cancelled ? "cancelled" : outcome.release.kind,
      approvedVia: call.notify,
    },
  };
}

/**
 * The pending map and its timers. One instance per proxy process, because a
 * hold is process state: a restart drops the queue, and the skeptic that
 * tests a hold outliving a restart is testing the recovery story, not this
 * class. The onExpire callback lets the proxy answer the blocked request
 * the moment the timer fires, so the agent never waits past its own
 * patience without an answer.
 */
export class HoldQueue {
  private readonly pending = new Map<HoldId, HeldCall>();
  private readonly resolvers = new Map<HoldId, (r: HoldResolution) => void>();
  private readonly timers = new Map<HoldId, ReturnType<typeof setTimeout>>();
  private readonly abortCleanup = new Map<HoldId, () => void>();
  private seq = 0;
  private closed = false;
  private readonly onExpire: (resolution: HoldResolution) => void;

  constructor(onExpire: (resolution: HoldResolution) => void = () => {}) {
    this.onExpire = onExpire;
  }

  /**
   * Parks a call and returns the promise its MCP response waits on. The
   * timer is unref'd so a queue with nothing left cannot keep the proxy
   * process alive.
   */
  hold(
    call: Omit<HeldCall, "id" | "heldAt" | "expiresAt">,
    seconds: number,
    signal?: AbortSignal,
  ): Promise<HoldResolution> {
    if (this.closed) throw new TypeError("the hold queue is closed");
    this.seq += 1;
    const id = `h${this.seq.toString(36).padStart(4, "0")}`;
    const heldAt = Date.now();
    const full: HeldCall = {
      ...call,
      ...(call.binding === undefined
        ? {}
        : { binding: Object.freeze({ ...call.binding }) }),
      id,
      heldAt,
      expiresAt: heldAt + seconds * 1000,
    };
    this.pending.set(id, full);
    const promise = new Promise<HoldResolution>((resolve) => {
      this.resolvers.set(id, resolve);
    });
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const outcome: HoldOutcome = { kind: "expired" };
      this.finish(id, outcome);
      this.onExpire({ id, outcome, call: full });
    }, seconds * 1000);
    timer.unref?.();
    this.timers.set(id, timer);
    if (signal !== undefined) {
      const onAbort = () => { this.cancel(id); };
      this.abortCleanup.set(id, () => signal.removeEventListener("abort", onAbort));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) queueMicrotask(onAbort);
    }
    return promise;
  }

  /** Resolves one pending request as cancelled without affecting other holds. */
  cancel(id: HoldId): boolean {
    if (!this.pending.has(id)) return false;
    this.clearTimer(id);
    this.finish(id, { kind: "cancelled" });
    return true;
  }

  /**
   * Resolves a pending hold. Caller-provided operator labels are retained in
   * the signature for compatibility, but never treated as identity evidence.
   */
  resolve(id: HoldId, release: Release, by?: string): boolean {
    void by;
    const call = this.pending.get(id);
    if (call === undefined) return false;
    const operator = verifiedLocalOperatorId();
    if (call.binding !== undefined && operator !== call.binding.operatorId)
      return false;
    const localRelease: Release = release.kind === "approved"
      ? call.binding === undefined ? { kind: "approved" } : { kind: "approved", by: operator }
      : { kind: "denied", by: operator };
    this.clearTimer(id);
    this.finish(id, { kind: "released", release: localRelease });
    return true;
  }

  list(): readonly HeldCall[] {
    return [...this.pending.values()].map((call) => ({ ...call }));
  }

  /** The shutdown path: everything waiting answers expired rather than hanging. */
  close(): readonly HoldResolution[] {
    this.closed = true;
    const drained: HoldResolution[] = [];
    for (const [id] of this.pending) {
      this.clearTimer(id);
      const outcome: HoldOutcome = { kind: "expired" };
      const call = this.pending.get(id)!;
      this.finish(id, outcome);
      drained.push({ id, outcome, call });
    }
    return drained;
  }

  private finish(id: HoldId, outcome: HoldOutcome): void {
    const resolve = this.resolvers.get(id);
    const call = this.pending.get(id);
    this.pending.delete(id);
    this.resolvers.delete(id);
    this.abortCleanup.get(id)?.();
    this.abortCleanup.delete(id);
    if (resolve !== undefined && call !== undefined) resolve({ id, outcome, call });
  }

  private clearTimer(id: HoldId): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }
}

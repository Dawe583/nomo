import { PolicyStartupError as ProxyPolicyStartupError } from "../../proxy/src/bin.ts";
import type { ApplyReport, ReplayRefusal } from "../../connectors/src/registry.ts";

export type VoidErrorCode =
  | "VOID_HOLD_DENIED"
  | "VOID_LEDGER_VERIFY"
  | "VOID_POLICY_STARTUP"
  | "VOID_REFUSED"
  | "VOID_REQUEST_OUTCOME_UNKNOWN";

export class HoldDeniedError extends Error {
  readonly code = "VOID_HOLD_DENIED";
  readonly holdId: string | undefined;
  readonly data: unknown;

  constructor(message: string, options: { readonly holdId?: string; readonly data?: unknown } = {}) {
    super(message);
    this.name = "HoldDeniedError";
    this.holdId = options.holdId;
    this.data = options.data;
  }
}

export class RequestOutcomeUnknownError extends Error {
  readonly code = "VOID_REQUEST_OUTCOME_UNKNOWN";
  readonly outcome = "unknown" as const;
  readonly method: string;
  readonly requestId: string | number;

  constructor(method: string, requestId: string | number) {
    super(`request ${method} timed out; its outcome is unknown. Do not retry until the signed ledger is reconciled.`);
    this.name = "RequestOutcomeUnknownError";
    this.method = method;
    this.requestId = requestId;
  }
}

export class LedgerVerifyError extends Error {
  readonly code = "VOID_LEDGER_VERIFY";
  readonly reason: string | undefined;
  readonly checked: number;

  constructor(message: string, options: { readonly reason?: string; readonly checked?: number } = {}) {
    super(message);
    this.name = "LedgerVerifyError";
    this.reason = options.reason;
    this.checked = options.checked ?? 0;
  }
}

export class PolicyStartupError extends ProxyPolicyStartupError {
  readonly code = "VOID_POLICY_STARTUP";

  constructor(message: string) {
    super(message);
    this.name = "PolicyStartupError";
  }
}

export type RefusalReason = ReplayRefusal["reason"];

export class RefusedError extends Error {
  readonly code = "VOID_REFUSED";
  readonly reason: RefusalReason;
  readonly refusal: ReplayRefusal;

  constructor(refusal: ReplayRefusal) {
    super(`VOID refused replay step ${refusal.stepId}: ${refusal.reason}`);
    this.name = "RefusedError";
    this.reason = refusal.reason;
    this.refusal = refusal;
  }

  static fromReport(report: ApplyReport): RefusedError | null {
    const [first] = report.refused;
    return first === undefined ? null : new RefusedError(first);
  }
}

/** Shared executable contract. Classification metadata alone is not an adapter. */
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Effect =
  "read" | "write" | "external-disclosure" | "mixed" | "unknown";
export type Reversibility = "r0" | "r1" | "r2" | "r3" | "unknown";
export type Readiness =
  | "verified"
  | "conditional"
  | "expired"
  | "unsupported"
  | "unknown-outcome"
  | "conflict";
export type Observation = {
  effect: Effect;
  reversibility: Reversibility;
  readiness: Readiness;
  scope: string;
  resources: string[];
  revision: Json;
  /**
   * What the adapter consulted to reach a decision, with the revision it saw.
   * Absent means the adapter reports no read set, never that it read nothing: a
   * planner that cannot prove a dependency must refuse to order around it, and
   * it cannot prove one from an absent field.
   */
  reads?: readonly { readonly resource: string; readonly revision: Json }[];
  blastRadius: {
    count: number | null;
    precision: "exact" | "bounded" | "unknown";
  };
};
export type Prepared = { before: Json; plan: Json };
export type Outcome = { result: Json; evidence: Json };
export type Reconciliation =
  | { status: "unknown" }
  | { status: "failed" }
  | { status: "succeeded"; outcome: Outcome };
export type RecoveryOutcome = {
  status: "restored" | "compensated" | "conflict";
  evidence: Json;
};
/** Runtime-derived proof that the immediately newer operation in a recovery
 * job was restored. Callers must never supply this to standalone recovery. */
export type RecoveryContinuation = {
  operationId: string;
  prepared: Prepared;
  outcome: Outcome;
  recovery: RecoveryOutcome;
};
export interface RecoveryAdapter {
  readonly id: string;
  readonly version: string;
  preflight(args: Json): Promise<Observation>;
  /** Must revalidate observation and own atomicity/CAS at the actual write boundary. */
  prepare(
    args: Json,
    observation: Observation,
    operationId: string,
  ): Promise<Prepared>;
  execute(
    args: Json,
    prepared: Prepared,
    operationId: string,
  ): Promise<Outcome>;
  /** Releases preparation resources before dispatch or after an execution error. Never retries. */
  release(operationId: string): Promise<void>;
  reconcile(operationId: string, prepared: Prepared): Promise<Reconciliation>;
  /** Must guard against drift and verify the declared scope before reporting restored. */
  recover(
    prepared: Prepared,
    outcome: Outcome,
    recoveryId: string,
  ): Promise<RecoveryOutcome>;
  /** Optional, narrowly-scoped continuation for a verified recovery job. */
  recoverWithContinuation?(
    prepared: Prepared,
    outcome: Outcome,
    recoveryId: string,
    previous: RecoveryContinuation,
  ): Promise<RecoveryOutcome>;
  /** Read durable recovery evidence only. An absent receipt never authorizes another inverse. */
  reconcileRecovery?(
    prepared: Prepared,
    outcome: Outcome,
    recoveryId: string,
  ): Promise<RecoveryOutcome | { status: "unknown" }>;
}

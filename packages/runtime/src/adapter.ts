/**
 * WP-R02 host integration contract for legacy tools.
 *
 * This is the dispatch and outcome half of gap G-08 in `PLAN-GAPS.md`: the
 * capture half lives in `packages/proxy/src/forward/legacy-binding.ts`, which
 * the proxy owns because it is the only place that knows an envelope was
 * written before the upstream was called. What both halves must share is the
 * rule that a call is bound from capture to outcome and that an uncertain
 * dispatch is never repeated.
 *
 * Deliberately not a `RecoveryAdapter`. The managed contract in
 * `connectors/src/recovery.ts` owns atomicity at the write boundary and
 * verifies an inverse before reporting restored; a legacy tool routed through
 * an MCP server has neither. Presenting a binding as recovery would be the
 * exact promotion `RECOVERY-CONTRACT.md` forbids, so nothing here returns a
 * recovery receipt.
 */

import { digest } from "./digest.ts";
import type { Json } from "../../connectors/src/recovery.ts";

export const LEGACY_OUTCOME_SCHEMA = "void.legacy.outcome.v1";

/**
 * `unknown` is a terminal state here, not a transient one. A dispatch that may
 * have reached the upstream is never retried by this module: the only safe next
 * step is the operator reading durable evidence.
 */
export type LegacyCallStatus =
  "captured" | "dispatched" | "succeeded" | "failed" | "denied" | "unknown";

export type LegacyCapture = {
  /** The capture gate's own digest, whatever the host chose to persist. */
  readonly digest: string;
  readonly at: string;
  /** Host supplied evidence. Never assumed to be a before image. */
  readonly evidence: Json;
};

export type LegacyDispatch = {
  readonly digest: string;
  readonly at: string;
};

export type LegacyOutcomeRecord = {
  readonly schema: typeof LEGACY_OUTCOME_SCHEMA;
  readonly status: LegacyCallStatus;
  readonly tool: string;
  readonly connector: string;
  readonly captureDigest: string;
  readonly dispatchDigest: string;
  readonly at: string;
  readonly result: Json;
  readonly reason: string | null;
};

export type LegacyBoundResult = {
  readonly status: LegacyCallStatus;
  readonly capture: LegacyCapture | null;
  readonly dispatch: LegacyDispatch | null;
  readonly outcome: LegacyOutcomeRecord | null;
};

export type LegacyToolCall = {
  readonly tool: string;
  readonly connector: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly workspace: string;
};

export type LegacyToolBinding = {
  readonly tool: string;
  readonly connector: string;
  /**
   * Must be durable and must complete before `dispatch` is called. A throw is
   * a refusal, and this module answers `failed` without attempting dispatch.
   */
  readonly capture: (call: LegacyToolCall) => Promise<Json>;
  readonly dispatch: (call: LegacyToolCall) => Promise<Json>;
  /**
   * Optional and never called automatically. A host that has a verified
   * inverse exposes it here; this module still refuses to present a result as
   * a recovery receipt, because undoing is the host's decision, not ours.
   */
  readonly undo?: (outcome: LegacyOutcomeRecord) => Promise<Json>;
};

const ID = /^[\w.:-]{1,200}$/;

/**
 * Binds an outcome to the capture and dispatch that produced it.
 *
 * The digest covers the capture and dispatch digests plus the status and the
 * result, but never the tool arguments, which stay in the ledger where the
 * auditor can read them. Recomputing it needs only the record itself, so an
 * outcome lifted out of context is detectable: the digest will not match.
 */
export function legacyOutcomeDigest(
  record: Omit<LegacyOutcomeRecord, "schema">,
): string {
  return digest({
    domain: LEGACY_OUTCOME_SCHEMA,
    status: record.status,
    tool: record.tool,
    connector: record.connector,
    captureDigest: record.captureDigest,
    dispatchDigest: record.dispatchDigest,
    result: record.result,
    reason: record.reason,
  });
}

const outcome = (
  binding: LegacyToolBinding,
  status: LegacyCallStatus,
  captureDigest: string,
  dispatchDigest: string,
  result: Json,
  reason: string | null,
  at: string,
): LegacyOutcomeRecord => {
  const record = {
    status,
    tool: binding.tool,
    connector: binding.connector,
    captureDigest,
    dispatchDigest,
    at,
    result,
    reason,
  } satisfies Omit<LegacyOutcomeRecord, "schema">;
  return { schema: LEGACY_OUTCOME_SCHEMA, ...record };
};

/**
 * The one place that orders capture, dispatch and outcome for a legacy tool.
 *
 * Three properties are load bearing and each has a test:
 *
 *   A capture failure never reaches `dispatch`. The upstream is not called,
 *   which is what makes the capture gate a gate.
 *   A dispatch that throws after it began is `unknown`, never `failed` and
 *   never retried, because the write may have landed.
 *   A dispatch that succeeds but whose result cannot be read is also
 *   `unknown`, for the same reason: the absence of a receipt is not evidence
 *   that nothing happened.
 */
export async function runLegacyBoundCall(
  binding: LegacyToolBinding,
  call: LegacyToolCall,
  now: () => Date = () => new Date(),
): Promise<LegacyBoundResult> {
  if (
    !ID.test(binding.tool) ||
    !ID.test(binding.connector) ||
    !ID.test(call.workspace) ||
    call.tool !== binding.tool
  )
    throw new Error("Invalid legacy tool binding identity.");

  let capture: LegacyCapture;
  try {
    const evidence = await binding.capture(call);
    capture = { digest: digest(evidence), at: now().toISOString(), evidence };
  } catch (error) {
    // Nothing was dispatched, so this is a plain failure and the call is safe
    // to retry. The reason is a named string, never the host's error text,
    // which can carry a connection string.
    return {
      status: "failed",
      capture: null,
      dispatch: null,
      outcome: outcome(
        binding,
        "failed",
        "",
        "",
        null,
        `capture refused: ${error instanceof Error ? error.name : "unknown"}`,
        now().toISOString(),
      ),
    };
  }

  const dispatch: LegacyDispatch = {
    digest: digest({ tool: call.tool, capture: capture.digest }),
    at: now().toISOString(),
  };

  let result: Json;
  try {
    result = await binding.dispatch(call);
  } catch (error) {
    return {
      status: "unknown",
      capture,
      dispatch,
      outcome: outcome(
        binding,
        "unknown",
        capture.digest,
        dispatch.digest,
        null,
        `dispatch outcome unconfirmed: ${error instanceof Error ? error.name : "unknown"}`,
        now().toISOString(),
      ),
    };
  }

  const at = now().toISOString();
  return {
    status: "succeeded",
    capture,
    dispatch,
    outcome: outcome(
      binding,
      "succeeded",
      capture.digest,
      dispatch.digest,
      result,
      null,
      at,
    ),
  };
}

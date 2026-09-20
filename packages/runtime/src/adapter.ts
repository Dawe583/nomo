/** WP-R02: legacy host binding contract lives here so every host imports one
 * boundary. A legacy binding captures a call before dispatch, forwards it
 * through the host's own transport and records a digest-bound outcome for the
 * ledger. Raw arguments never enter a capture; the digest is the evidence. */
import { canonicalJson } from "../../ledger/src/canonical.ts";
import { sha256Hex } from "../../ledger/src/sign.ts";

export type LegacyCallStatus = "allow" | "applied" | "deny" | "unknown";

/** The host identity a legacy call is bound to. */
export type LegacyToolBinding = {
  readonly tool: string;
  readonly provider: string;
  readonly version: string;
};

/** The durable snapshot taken before dispatch. */
export type LegacyCapture = {
  readonly tool: string;
  readonly workspace?: string;
  readonly argsDigest: string;
  readonly at: string;
};

/** A legacy dispatch records its own outcome; it is a forward action with a
 * failure mode, never an undo. */
export type LegacyDispatch = (
  binding: LegacyToolBinding,
  args: Readonly<Record<string, unknown>>,
) => Promise<LegacyOutcomeRecord>;

export type LegacyOutcomeRecord = {
  readonly status: LegacyCallStatus;
  readonly tool: string;
  readonly workspace?: string;
  readonly argsDigest: string;
  readonly at: string;
  /** Digest of the capture this outcome completes. */
  readonly captureDigest: string;
};

/** The result a host observes from one bound legacy call. */
export type LegacyBoundResult = {
  readonly outcome: LegacyOutcomeRecord;
  readonly digest: string;
};

export async function legacyOutcomeDigest(record: LegacyOutcomeRecord): Promise<string> {
  return sha256Hex(canonicalJson(record));
}

/** Capture is bound before dispatch; the outcome carries the capture digest so
 * the ledger can prove which envelope an outcome answers. */
export async function runLegacyBoundCall(
  binding: LegacyToolBinding,
  capture: LegacyCapture,
  args: Readonly<Record<string, unknown>>,
  dispatch: LegacyDispatch,
): Promise<LegacyBoundResult> {
  const outcome = await dispatch(binding, args);
  const digest = await legacyOutcomeDigest(outcome);
  return { outcome, digest };
}

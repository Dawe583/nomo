/** Generic evidence contract for a legacy MCP host binding. Raw arguments and
 * provider results never enter these records. */
import { canonicalJson } from "../../../ledger/src/canonical.ts";
import { sha256Hex } from "../../../ledger/src/sign.ts";

import type { JsonRpcError, JsonRpcResult } from "../rpc.ts";
import type { InterceptedCall } from "./tools.ts";

export type LegacyEnvelope = {
  readonly schema: "void.legacy.envelope.v1";
  readonly at: string;
  readonly tool: string;
  readonly workspace?: string;
  readonly argsDigest: string;
};

export type LegacyCaptureEvidence = {
  readonly schema: "void.legacy.capture.v1";
  readonly at: string;
  readonly tool: string;
  readonly workspace?: string;
  readonly argsDigest: string;
  readonly captureDigest: string;
  readonly reference: {
    readonly namespace: string;
    readonly digest: string;
    readonly uri: string;
  };
};

export type LegacyOutcomeStatus = "completed" | "failed" | "unknown";

export type LegacyOutcomeEvidence = {
  readonly schema: "void.legacy.outcome.v1";
  readonly at: string;
  readonly status: LegacyOutcomeStatus;
  readonly tool: string;
  readonly workspace?: string;
  readonly argsDigest: string;
  readonly captureDigest: string;
};

export type LegacyProxyBinding = {
  readonly tool: string;
  readonly capture: (
    call: InterceptedCall,
    argsDigest: string,
  ) => Promise<LegacyCaptureEvidence>;
  readonly dispatched: (evidence: LegacyCaptureEvidence) => Promise<void>;
  readonly outcome: (
    evidence: LegacyCaptureEvidence,
    response: JsonRpcResult | JsonRpcError | null,
  ) => Promise<LegacyOutcomeEvidence>;
};

export type LegacyBindingResolver = (
  call: InterceptedCall,
) => LegacyProxyBinding | null;

export async function legacyArgsDigest(
  args: Readonly<Record<string, unknown>>,
): Promise<string> {
  return sha256Hex(canonicalJson(args));
}

export async function captureLegacyEnvelope(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  workspace?: string,
): Promise<LegacyEnvelope> {
  return {
    schema: "void.legacy.envelope.v1",
    at: new Date().toISOString(),
    tool,
    workspace,
    argsDigest: await legacyArgsDigest(args),
  };
}

export function validateLegacyCapture(
  call: InterceptedCall,
  argsDigest: string,
  evidence: LegacyCaptureEvidence,
): void {
  if (evidence.schema !== "void.legacy.capture.v1") {
    throw new Error("legacy capture schema mismatch");
  }
  if (evidence.tool !== call.tool) {
    throw new Error("legacy capture tool mismatch");
  }
  if (evidence.workspace !== call.workspace) {
    throw new Error("legacy capture workspace mismatch");
  }
  if (evidence.argsDigest !== argsDigest) {
    throw new Error("legacy capture argument digest mismatch");
  }
  if (!isDigest(argsDigest)) {
    throw new Error("legacy capture argument digest is invalid");
  }
  if (!isSnapshotDigest(evidence.captureDigest)) {
    throw new Error("legacy capture digest is invalid");
  }
  if (evidence.reference.digest !== evidence.captureDigest) {
    throw new Error("legacy capture reference digest mismatch");
  }
  if (evidence.reference.namespace === "" || evidence.reference.uri === "") {
    throw new Error("legacy capture reference is incomplete");
  }
  if (Number.isNaN(Date.parse(evidence.at))) {
    throw new Error("legacy capture time is invalid");
  }
}

export function validateLegacyOutcome(
  capture: LegacyCaptureEvidence,
  response: JsonRpcResult | JsonRpcError | null,
  outcome: LegacyOutcomeEvidence,
): void {
  if (outcome.schema !== "void.legacy.outcome.v1") {
    throw new Error("legacy outcome schema mismatch");
  }
  if (outcome.tool !== capture.tool) {
    throw new Error("legacy outcome tool mismatch");
  }
  if (outcome.workspace !== capture.workspace) {
    throw new Error("legacy outcome workspace mismatch");
  }
  if (outcome.argsDigest !== capture.argsDigest) {
    throw new Error("legacy outcome argument digest mismatch");
  }
  if (outcome.captureDigest !== capture.captureDigest) {
    throw new Error("legacy outcome capture digest mismatch");
  }
  if (Number.isNaN(Date.parse(outcome.at))) {
    throw new Error("legacy outcome time is invalid");
  }
  if (response === null && outcome.status !== "unknown") {
    throw new Error("legacy outcome must be unknown without a response");
  }
  if (response !== null && "error" in response && outcome.status !== "failed") {
    throw new Error("legacy JSON-RPC error outcome must be failed");
  }
}

function isDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isSnapshotDigest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

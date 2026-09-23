import test from "node:test";
import assert from "node:assert/strict";

import type { JsonRpcError, JsonRpcResult } from "../rpc.ts";
import {
  legacyArgsDigest,
  validateLegacyCapture,
  validateLegacyOutcome,
  validateLegacyRecoveryEvidence,
  type LegacyCaptureEvidence,
  type LegacyOutcomeEvidence,
} from "./legacy-binding.ts";

const call = {
  tool: "postgres.row.update",
  connector: "postgres",
  workspace: "isolated",
  args: { sql: "update account set balance = 20 where id = 1" },
} as const;

const capture: LegacyCaptureEvidence = {
  schema: "void.legacy.capture.v1",
  at: "2026-09-23T00:00:00.000Z",
  tool: call.tool,
  workspace: call.workspace,
  argsDigest: "a".repeat(64),
  captureDigest: `sha256:${"b".repeat(64)}`,
  reference: {
    namespace: "isolated/postgres",
    digest: `sha256:${"b".repeat(64)}`,
    uri: "file:///snapshot",
  },
};

function outcome(status: LegacyOutcomeEvidence["status"]): LegacyOutcomeEvidence {
  return {
    schema: "void.legacy.outcome.v1",
    at: "2026-09-23T00:00:01.000Z",
    status,
    tool: capture.tool,
    workspace: capture.workspace,
    argsDigest: capture.argsDigest,
    captureDigest: capture.captureDigest,
  };
}

test("legacy argument digest uses canonical JSON", async () => {
  assert.equal(
    await legacyArgsDigest({ b: 2, a: 1 }),
    await legacyArgsDigest({ a: 1, b: 2 }),
  );
});

test("legacy capture validation binds call identity and snapshot digest", () => {
  assert.doesNotThrow(() => validateLegacyCapture(call, capture.argsDigest, capture));
  for (const changed of [
    { ...capture, tool: "postgres.row.delete" },
    { ...capture, workspace: "other" },
    { ...capture, argsDigest: "c".repeat(64) },
    { ...capture, captureDigest: `sha256:${"d".repeat(64)}` },
  ]) {
    assert.throws(
      () => validateLegacyCapture(call, capture.argsDigest, changed),
      /legacy capture/,
    );
  }
});

test("legacy outcome validation binds capture and response kind", () => {
  const result: JsonRpcResult = { jsonrpc: "2.0", id: 1, result: { applied: true } };
  const error: JsonRpcError = {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000, message: "failed" },
  };
  assert.doesNotThrow(() => validateLegacyOutcome(capture, result, outcome("completed")));
  assert.doesNotThrow(() => validateLegacyOutcome(capture, error, outcome("failed")));
  assert.doesNotThrow(() => validateLegacyOutcome(capture, null, outcome("unknown")));
  assert.throws(
    () => validateLegacyOutcome(capture, null, outcome("completed")),
    /unknown/,
  );
  assert.throws(
    () => validateLegacyOutcome(capture, error, outcome("completed")),
    /failed/,
  );
  assert.throws(
    () => validateLegacyOutcome(capture, result, { ...outcome("completed"), captureDigest: `sha256:${"e".repeat(64)}` }),
    /capture digest/,
  );
});

test("legacy recovery requires matching completed evidence", () => {
  assert.doesNotThrow(() => validateLegacyRecoveryEvidence(capture, outcome("completed")));
  assert.throws(
    () => validateLegacyRecoveryEvidence(capture, outcome("failed")),
    /completed/,
  );
  assert.throws(
    () => validateLegacyRecoveryEvidence(capture, { ...outcome("completed"), argsDigest: "c".repeat(64) }),
    /argument digest/,
  );
});

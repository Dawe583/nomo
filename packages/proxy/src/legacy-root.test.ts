import test from "node:test";
import assert from "node:assert/strict";

import {
  legacyBindingRoot,
  UnknownLegacyBindingError,
  LEGACY_BINDING_NAMES,
  type LegacyBindingLedgerBody,
  type LegacyBindingManifestEntry,
  type LegacyBindingSnapshot,
  type LegacyBoundCall,
  type LegacyRootDeps,
} from "./legacy-root.ts";
import {
  validateLegacyCapture,
  validateLegacyOutcome,
  validateLegacyRecoveryEvidence,
} from "./forward/legacy-binding.ts";
import type { JsonRpcResult } from "./rpc.ts";
import type { InterceptedCall } from "./forward/tools.ts";

const WORKSPACE = "isolated";

function call(tool: string, args: Record<string, unknown> = {}): InterceptedCall {
  return { tool, connector: tool.split(".")[0]!, args, workspace: WORKSPACE };
}

type Harness = {
  readonly deps: LegacyRootDeps;
  readonly captures: LegacyBoundCall[];
  readonly manifest: LegacyBindingManifestEntry[];
  readonly ledger: LegacyBindingLedgerBody[];
  readonly captureResult: { value: LegacyBindingSnapshot | Error };
};

function harness(overrides: Partial<LegacyRootDeps> = {}): Harness {
  const captures: LegacyBoundCall[] = [];
  const manifest: LegacyBindingManifestEntry[] = [];
  const ledger: LegacyBindingLedgerBody[] = [];
  const captureResult: { value: LegacyBindingSnapshot | Error } = {
    value: {
      digest: `sha256:${"a".repeat(64)}`,
      reference: {
        namespace: "postgres-isolated",
        digest: `sha256:${"a".repeat(64)}`,
        uri: "file:///snapshots/a",
      },
      capturedAt: "2026-09-25T00:00:00.000Z",
    },
  };
  const deps: LegacyRootDeps = {
    async capture(received) {
      captures.push(received);
      if (captureResult.value instanceof Error) throw captureResult.value;
      return captureResult.value;
    },
    manifest: {
      async write(entry) {
        manifest.push(entry);
      },
    },
    ledger: {
      async append(body) {
        ledger.push(body);
        return body;
      },
    },
    workspace: WORKSPACE,
    completed: (result) =>
      typeof result === "object" &&
      result !== null &&
      (result as { applied?: unknown }).applied === true,
    now: () => new Date("2026-09-25T00:00:01.000Z"),
    ...overrides,
  };
  return { deps, captures, manifest, ledger, captureResult };
}

const ARGS_DIGEST = "b".repeat(64);

test("an unknown binding name is refused instead of guessed", () => {
  const { deps } = harness();
  assert.throws(
    () => legacyBindingRoot("postgres.table.drop", deps),
    UnknownLegacyBindingError,
  );
  assert.throws(() => legacyBindingRoot("stripe.refund.create", deps), /unknown legacy binding/);
  // An empty or whitespace name is a misconfiguration, not a wildcard.
  assert.throws(() => legacyBindingRoot("", deps), UnknownLegacyBindingError);
});

test("every advertised name resolves and no other name is advertised", () => {
  const { deps } = harness();
  for (const name of LEGACY_BINDING_NAMES) {
    const resolver = legacyBindingRoot(name, deps);
    assert.notEqual(resolver(call(name)), null, `${name} must resolve`);
  }
  // The refusal test above pins the boundary; this pins the positive side so a
  // name cannot be quietly dropped from the supported set.
  assert.deepEqual([...LEGACY_BINDING_NAMES], [
    "postgres.row.update",
    "postgres.row.delete",
    "aws.s3.object.delete",
  ]);
});

test("the resolver binds only its own tool and leaves other tools unbound", () => {
  const { deps } = harness();
  const resolver = legacyBindingRoot("postgres.row.update", deps);
  assert.notEqual(resolver(call("postgres.row.update")), null);
  assert.equal(resolver(call("postgres.row.delete")), null);
  assert.equal(resolver(call("aws.s3.object.delete")), null);
});

test("capture translates args to arguments and records the manifest before returning", async () => {
  const { deps, captures, manifest } = harness();
  const binding = legacyBindingRoot("postgres.row.update", deps)(
    call("postgres.row.update", { sql: "update account set balance = 20" }),
  );
  assert.notEqual(binding, null);
  const evidence = await binding!.capture(
    call("postgres.row.update", { sql: "update account set balance = 20" }),
    ARGS_DIGEST,
  );
  assert.deepEqual(captures, [
    {
      tool: "postgres.row.update",
      connector: "postgres",
      arguments: { sql: "update account set balance = 20" },
      workspace: WORKSPACE,
    },
  ]);
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0]?.digest, evidence.captureDigest);
  assert.deepEqual(manifest[0]?.reference, evidence.reference);
  validateLegacyCapture(call("postgres.row.update"), ARGS_DIGEST, evidence);
});

test("a manifest write failure rejects the capture so the upstream is never reached", async () => {
  const { deps, ledger } = harness({
    manifest: {
      async write() {
        throw new Error("manifest unavailable");
      },
    },
  });
  const binding = legacyBindingRoot("postgres.row.update", deps)(
    call("postgres.row.update"),
  );
  await assert.rejects(
    binding!.capture(call("postgres.row.update"), ARGS_DIGEST),
    /manifest unavailable/,
  );
  assert.deepEqual(ledger, []);
});

test("a capture failure never reaches the manifest or the ledger", async () => {
  const h = harness();
  h.captureResult.value = new Error("no before image");
  const binding = legacyBindingRoot("postgres.row.update", h.deps)(
    call("postgres.row.update"),
  );
  await assert.rejects(
    binding!.capture(call("postgres.row.update"), ARGS_DIGEST),
    /no before image/,
  );
  assert.deepEqual(h.manifest, []);
  assert.deepEqual(h.ledger, []);
});

test("a call stamped with a foreign workspace is refused before capture", async () => {
  const { deps, captures } = harness();
  const binding = legacyBindingRoot("postgres.row.update", deps)(
    call("postgres.row.update"),
  );
  await assert.rejects(
    binding!.capture(
      { tool: "postgres.row.update", connector: "postgres", args: {}, workspace: "other" },
      ARGS_DIGEST,
    ),
    /workspace mismatch/,
  );
  assert.deepEqual(captures, []);
});

test("dispatch records a durable execute:dispatched line before the upstream answers", async () => {
  const { deps, ledger } = harness();
  const binding = legacyBindingRoot("postgres.row.update", deps)(
    call("postgres.row.update"),
  )!;
  const evidence = await binding.capture(call("postgres.row.update"), ARGS_DIGEST);
  await binding.dispatched(evidence);
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0], {
    workspace: WORKSPACE,
    at: "2026-09-25T00:00:01.000Z",
    tool: "postgres.row.update",
    schema: "void.legacy.capture.v1",
    decision: "execute:dispatched",
    argsDigest: ARGS_DIGEST,
    captureDigest: evidence.captureDigest,
  });
});

test("a proved result is completed, an unproved result is unknown, an error is failed", async () => {
  const { deps, ledger } = harness();
  const binding = legacyBindingRoot("postgres.row.update", deps)(
    call("postgres.row.update"),
  )!;
  const evidence = await binding.capture(call("postgres.row.update"), ARGS_DIGEST);
  const applied: JsonRpcResult = { jsonrpc: "2.0", id: 1, result: { applied: true } };
  const unproved: JsonRpcResult = { jsonrpc: "2.0", id: 1, result: { ok: true } };

  const completedOutcome = await binding.outcome(evidence, applied);
  assert.equal(completedOutcome.status, "completed");
  validateLegacyOutcome(evidence, applied, completedOutcome);
  validateLegacyRecoveryEvidence(evidence, completedOutcome);

  const unknownOutcome = await binding.outcome(evidence, unproved);
  assert.equal(unknownOutcome.status, "unknown");
  validateLegacyOutcome(evidence, unproved, unknownOutcome);
  assert.throws(
    () => validateLegacyRecoveryEvidence(evidence, unknownOutcome),
    /completed/,
  );

  const failedOutcome = await binding.outcome(evidence, {
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32000, message: "upstream refused" },
  });
  assert.equal(failedOutcome.status, "failed");

  const absentOutcome = await binding.outcome(evidence, null);
  assert.equal(absentOutcome.status, "unknown");

  // One decision per outcome, in call order. No dispatch line: this test
  // never dispatches, and an outcome must not invent one.
  assert.deepEqual(
    ledger.map((entry) => entry.decision),
    [
      "execute:completed",
      "execute:unknown",
      "execute:failed",
      "execute:unknown",
    ],
  );
  for (const entry of ledger) {
    assert.equal(entry.workspace, WORKSPACE);
    assert.equal(entry.captureDigest, evidence.captureDigest);
    assert.equal(entry.argsDigest, ARGS_DIGEST);
  }
});

test("the outcome is appended before it is returned, so a returned outcome is already durable", async () => {
  const seen: string[] = [];
  const { deps } = harness({
    ledger: {
      async append(body) {
        seen.push(`append:${body.decision}`);
        return body;
      },
    },
  });
  const binding = legacyBindingRoot("postgres.row.update", deps)(
    call("postgres.row.update"),
  )!;
  const evidence = await binding.capture(call("postgres.row.update"), ARGS_DIGEST);
  const promise = binding
    .outcome(evidence, { jsonrpc: "2.0", id: 1, result: { applied: true } })
    .then((outcome) => {
      seen.push(`return:${outcome.status}`);
      return outcome;
    });
  await promise;
  assert.deepEqual(seen, ["append:execute:completed", "return:completed"]);
});

test("the s3 name binds against the same single point, not a second mechanism", async () => {
  const { deps, captures } = harness();
  const binding = legacyBindingRoot("aws.s3.object.delete", deps)(
    call("aws.s3.object.delete", { bucket: "b", key: "k" }),
  );
  assert.notEqual(binding, null);
  assert.equal(binding?.tool, "aws.s3.object.delete");
  const evidence = await binding!.capture(
    call("aws.s3.object.delete", { bucket: "b", key: "k" }),
    ARGS_DIGEST,
  );
  // The proxy stamps the connector from the vendor prefix, which for the s3
  // surface is "aws", not "s3". Resolving that prefix to the s3 connector is
  // the registry's job; the root must pass the stamp through unchanged
  // rather than re-guessing a connector name the host already decided.
  assert.equal(captures[0]?.connector, "aws");
  assert.deepEqual(captures[0]?.arguments, { bucket: "b", key: "k" });
  assert.equal(evidence.tool, "aws.s3.object.delete");
});

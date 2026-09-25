import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../packages/ledger/src/canonical.ts";
import { decodeCompanionFixture, validateCompanionFixture } from "./companion-fixtures.mjs";

const digest = (body) => createHash("sha256").update(canonicalJson(body)).digest("hex");
const root = join(import.meta.dirname, "..", "..", "apps", "apple", "Fixtures", "Protocol");

test("decoder validates every shared P04 fixture", async () => {
  const names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
  assert.equal(names.length, 7);
  for (const name of names) {
    const fixture = decodeCompanionFixture(await readFile(join(root, name), "utf8"));
    assert.equal(fixture.protocol, "void.companion.v1", name);
  }
});

test("validator rejects unknown fields, identity drift, and unsafe outcome metadata", async () => {
  const source = JSON.parse(await readFile(join(root, "unknown.json"), "utf8"));
  assert.throws(() => validateCompanionFixture({ ...source, extra: true }), /unknown field/);
  const identity = structuredClone(source);
  identity.response.operationId = "different";
  assert.throws(() => validateCompanionFixture(identity), /identity/);
  const outcome = structuredClone(source);
  outcome.response.error.retryable = true;
  assert.throws(() => validateCompanionFixture(outcome), /unknown/);
 const scope = structuredClone(source);
 scope.response.workspaceId = "workspace-other";
 assert.throws(() => validateCompanionFixture(scope), /identity/);
 const revoked = JSON.parse(await readFile(join(root, "revoked.json"), "utf8"));
 revoked.response.body.newMutationsAllowed = true;
 assert.throws(() => validateCompanionFixture(revoked), /revoked/);
  const digest = structuredClone(source);
  digest.request.bodyDigest = "0".repeat(64);
  assert.throws(() => validateCompanionFixture(digest), /digest/);
 const operation = structuredClone(source);
 operation.request.operation = "session.unknown";
 assert.throws(() => validateCompanionFixture(operation), /operation/);
 const missingKey = structuredClone(source);
 delete missingKey.request.idempotencyKey;
 assert.throws(() => validateCompanionFixture(missingKey), /idempotency/);
});
test("validator applies discriminated operation schemas", async () => {
  const handshake = JSON.parse(await readFile(join(root, "capability-handshake.json"), "utf8"));
  const handshakeBody = structuredClone(handshake);
  handshakeBody.request.body.requestedCapabilities.push("session.unknown");
  handshakeBody.request.bodyDigest = digest(handshakeBody.request.body);
  assert.throws(() => validateCompanionFixture(handshakeBody), /handshake/);

  const apply = JSON.parse(await readFile(join(root, "succeeded.json"), "utf8"));
  const applyBody = structuredClone(apply);
  applyBody.request.body.approved = "true";
  applyBody.request.bodyDigest = digest(applyBody.request.body);
  assert.throws(() => validateCompanionFixture(applyBody), /recovery\.apply/);
  const receipt = structuredClone(apply);
  receipt.response.body.outcomes[0].status = "unknown";
  assert.throws(() => validateCompanionFixture(receipt), /recovery\.apply/);

  const approval = JSON.parse(await readFile(join(root, "denied.json"), "utf8"));
  const approvalBody = structuredClone(approval);
  approvalBody.request.body.decision = "approved";
  approvalBody.request.bodyDigest = digest(approvalBody.request.body);
  assert.throws(() => validateCompanionFixture(approvalBody), /approval\.decide/);
});

test("validator rejects unknown fields for every catalog operation", () => {
  const make = (operation, body, responseBody) => {
    const request = {
      protocol: "void.companion.v1", schemaVersion: 1, kind: "request", requestId: `req-${operation}`,
      operationId: `op-${operation}`, operation, deviceId: "device-1", workspaceId: "workspace-1",
      ...(operation !== "capability.handshake" && ["session.read", "session.send", "session.cancel", "events.read", "events.stream", "approval.decide", "recovery.preview", "recovery.apply", "recovery.status"].includes(operation) ? { sessionId: "session-1" } : {}),
      ...(["session.create", "session.send", "session.cancel", "approval.decide", "recovery.apply", "device.revoke"].includes(operation) ? { idempotencyKey: `idem-${operation}` } : {}),
      issuedAt: "2026-09-24T12:00:00.000Z", expiresAt: "2026-09-24T12:01:00.000Z", bodyDigest: digest(body), body,
    };
    return { fixture: `void.companion.v1.${operation}`, protocol: "void.companion.v1", schemaVersion: 1,
      implementation: { server: "pending", apple: "pending", transport: "pending", authority: "not-granted" },
      sourceRoutes: ["fixture"], request, response: { protocol: "void.companion.v1", schemaVersion: 1, kind: "response", requestId: request.requestId, operationId: request.operationId, operation, deviceId: request.deviceId, workspaceId: request.workspaceId, httpStatus: 200, outcome: "succeeded", body: responseBody } };
  };
  const cases = [
    ["session.list", {}, { sessions: [] }],
    ["session.read", {}, { session: { sessionId: "session-1", workspaceId: "workspace-1" } }],
    ["session.create", { prompt: "hello" }, { session: { sessionId: "session-1", workspaceId: "workspace-1" } }],
    ["session.send", { prompt: "hello" }, { ok: true }],
    ["session.cancel", {}, { ok: true }],
    ["events.read", {}, { items: [], after: "0", nextAfter: null, hasMore: false, historyComplete: true, scope: { workspaceId: "workspace-1", sessionId: "session-1" }, asOf: "2026-09-24T12:00:00.000Z", replayExpiresAt: "2026-09-24T12:15:00.000Z" }],
    ["events.stream", {}, { closed: true }],
    ["approval.list", {}, { approvals: [] }],
    ["recovery.preview", { operationId: "op-recovery.preview", idempotencyKey: "idem-recovery.preview", jobId: "job-1", selection: { kind: "run", runId: "run-1" } }, { jobId: "job-1", planDigest: "0".repeat(64), selection: { kind: "run", runId: "run-1" }, boundary: { sequence: 1, digest: "0".repeat(64) }, steps: [], residuals: [], expiresAt: "2026-09-24T12:15:00.000Z", canApply: true }],
    ["recovery.status", { jobId: "job-1" }, { jobId: "job-1", status: "restored", checkpoint: 0, outcomes: [], residuals: [] }],
    ["operation.status", { operationId: "op-operation.status" }, { operationId: "op-operation.status", status: "succeeded" }],
    ["device.revoke", { deviceId: "device-1" }, { deviceId: "device-1", revokedAt: "2026-09-24T12:00:00.000Z", newMutationsAllowed: false, activeStreamsClosed: true }],
    ["diagnostics.read", {}, { entries: [] }],
  ];
  for (const [operation, body, responseBody] of cases) {
    const valid = make(operation, body, responseBody);
    assert.doesNotThrow(() => validateCompanionFixture(valid), operation);
    const invalid = structuredClone(valid);
    invalid.request.body.unexpected = true;
    invalid.request.bodyDigest = digest(invalid.request.body);
    assert.throws(() => validateCompanionFixture(invalid), new RegExp(operation.replace(".", "\\.")), operation);
    const invalidResponse = structuredClone(valid);
    invalidResponse.response.body.unexpected = true;
    assert.throws(() => validateCompanionFixture(invalidResponse), operation.startsWith("recovery.") ? /recovery/ : new RegExp(operation.replace(".", "\\.")), `${operation} response`);
    if (operation === "session.list") {
      const drift = structuredClone(valid);
      drift.response.body.sessions.push({ id: "session-other", workspaceId: "workspace-other" });
      assert.throws(() => validateCompanionFixture(drift), /session\.list/);
    }
    if (operation === "events.read") {
      const drift = structuredClone(valid);
      drift.response.body.items.push({ id: "event-other", sessionId: "session-other", seq: 1, at: "2026-09-24T12:00:01.000Z", type: "status", kind: "event", schemaVersion: 1 });
      assert.throws(() => validateCompanionFixture(drift), /events\.read/);
    }
    if (operation === "approval.list") {
      const drift = structuredClone(valid);
      drift.response.body.approvals.push({ approvalId: "approval-other", sessionId: "session-other", operationId: "op-other", workspaceId: "workspace-other", tool: "test", class: "r1", status: "pending", expiresAt: "2026-09-24T12:05:00.000Z", requestDigest: "1".repeat(64), requiredScope: "approvals:decide" });
      assert.throws(() => validateCompanionFixture(drift), /approval\.list/);
    }
    if (operation === "recovery.status") {
      const drift = structuredClone(valid);
      drift.response.body.jobId = "job-other";
      assert.throws(() => validateCompanionFixture(drift), /recovery\.apply/);
    }
    if (operation === "operation.status") {
      const drift = structuredClone(valid);
      drift.response.body.operationId = "op-other";
      assert.throws(() => validateCompanionFixture(drift), /operation\.status/);
    }
    if (operation === "device.revoke") {
      const drift = structuredClone(valid);
      drift.response.body.deviceId = "device-other";
      assert.throws(() => validateCompanionFixture(drift), /device\.revoke/);
    }
  }
});

test("recovery and operation status reject contradictory outcome payloads", async () => {
  const apply = JSON.parse(await readFile(join(root, "succeeded.json"), "utf8"));
  const contradictoryApply = structuredClone(apply);
  contradictoryApply.response.outcome = "conflict";
  contradictoryApply.response.httpStatus = 409;
  contradictoryApply.response.error = { code: "human_edit_conflict", message: "Changed state.", retryable: false };
  assert.throws(() => validateCompanionFixture(contradictoryApply), /recovery\.apply/);

  const contradictoryUnknown = structuredClone(apply);
  contradictoryUnknown.response.outcome = "unknown";
  contradictoryUnknown.response.httpStatus = 202;
  contradictoryUnknown.response.error = { code: "operation_unknown", message: "Outcome is not confirmed.", retryable: false, reconcileRequired: true };
  assert.throws(() => validateCompanionFixture(contradictoryUnknown), /recovery\.apply/);

  const status = structuredClone(apply);
  status.request.operation = "recovery.status";
  status.request.body = { jobId: "job-succeeded-001" };
  status.request.bodyDigest = digest(status.request.body);
  status.request.idempotencyKey = undefined;
  status.response.operation = "recovery.status";
  status.response.outcome = "denied";
  assert.throws(() => validateCompanionFixture(status), /recovery\.status/);

  const operation = structuredClone(apply);
  operation.request.operation = "operation.status";
  operation.request.body = { operationId: "op-succeeded-001" };
  operation.request.bodyDigest = digest(operation.request.body);
  operation.request.idempotencyKey = undefined;
  operation.response.operation = "operation.status";
  operation.response.outcome = "conflict";
  operation.response.httpStatus = 409;
  operation.response.body = { operationId: "op-succeeded-001", status: "succeeded" };
  operation.response.error = { code: "request_in_flight", message: "State changed.", retryable: false };
  assert.throws(() => validateCompanionFixture(operation), /operation\.status/);
});

test("validator enforces protocol limit ceilings and outcome status mapping", async () => {
  const fixture = JSON.parse(await readFile(join(root, "capability-handshake.json"), "utf8"));
  const ceilings = {
    maxRequestBytes: 65_536,
    maxPromptCharacters: 32_000,
    maxEventsPerPage: 1_000,
    maxEventPageBytes: 1_048_576,
    maxEventBytes: 32_768,
    maxStreamSeconds: 55,
    replayWindowSeconds: 900,
    idempotencyRetentionHours: 24,
    deviceCredentialSeconds: 900,
    invitationSeconds: 120,
    grantSeconds: 300,
    recoveryPlanSeconds: 900,
    maxMutationsPerDevice: 2,
    maxStreamsPerDevice: 2,
    maxDevicesPerWorkspace: 8,
    maxOperationIds: 500,
    maxErrorCharacters: 320,
  };
  for (const [key, maximum] of Object.entries(ceilings)) {
    const bounded = structuredClone(fixture);
    bounded.response.body.limits[key] = maximum;
    assert.doesNotThrow(() => validateCompanionFixture(bounded), key);
    bounded.response.body.limits[key] = maximum + 1;
    assert.throws(() => validateCompanionFixture(bounded), /handshake limit/, key);
  }

  const statusDrift = JSON.parse(await readFile(join(root, "succeeded.json"), "utf8"));
  statusDrift.response.httpStatus = 500;
  assert.throws(() => validateCompanionFixture(statusDrift), /http status/);
});

test("P04 rejects oversized event pages and ambiguous success status", async () => {
  const fixture = JSON.parse(await readFile(join(root, "succeeded.json"), "utf8"));
  const statusDrift = structuredClone(fixture);
  statusDrift.response.httpStatus = 202;
  assert.throws(() => validateCompanionFixture(statusDrift), /http status/);

  const events = JSON.parse(await readFile(join(root, "succeeded.json"), "utf8"));
  events.request.operation = "events.read";
  events.request.body = { after: "0" };
  events.request.bodyDigest = digest(events.request.body);
  events.response.operation = "events.read";
  events.response.httpStatus = 200;
  events.response.outcome = "succeeded";
  events.response.body = {
    items: Array.from({ length: 1000 }, (_, index) => ({
      id: `event-${index}`, sessionId: events.request.sessionId, runId: "r".repeat(120), seq: index + 1,
      at: "2026-09-24T12:00:00.000Z", type: "s".repeat(120), kind: "k".repeat(120), schemaVersion: 1,
      summary: "x".repeat(320), metadata: { status: "s".repeat(160), decision: "d".repeat(160), class: "c".repeat(160), operationId: "o".repeat(160), resultCategory: "r".repeat(160) },
    })),
    after: "0", nextAfter: "1000", hasMore: false, historyComplete: true,
    scope: { workspaceId: events.request.workspaceId, sessionId: events.request.sessionId },
    asOf: "2026-09-24T12:00:00.000Z", replayExpiresAt: "2026-09-24T12:15:00.000Z",
  };
  assert.throws(() => validateCompanionFixture(events), /maxEventPageBytes/);
});

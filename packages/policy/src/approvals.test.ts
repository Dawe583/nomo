import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalBroker, loadPending, type ApprovalNotification } from "./approvals.ts";
import { HoldQueue, holdErrorMessage, verifiedLocalOperatorId } from "./hold.ts";
import type { PolicyCall } from "./decide.ts";

describe("ApprovalBroker", () => {
  test("register records the pending hold and notifies the configured channel", () => {
    const notifications: ApprovalNotification[] = [];
    const queue = new HoldQueue();
    const call = policyCall();
    const binding = approvalBinding("operation-notify", "a");
    void queue.hold({
      ...heldCall(),
      args: { bucket: "archive-primary", apiKey: "nomo-secret-sentinel" },
      binding,
    } as unknown as Parameters<HoldQueue["hold"]>[0], 60);
    const broker = new ApprovalBroker({
      channels: {
        cli: { notify(approval) { notifications.push(approval); } },
      },
    });

    const record = broker.register(queue, call);

    assert.equal(record.holdId, "h0001");
    assert.equal(record.status, "pending");
    assert.equal(record.call.tool, call.tool);
    assert.deepEqual(record.notify, ["cli"]);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.holdId, record.holdId);
    const notification = notifications[0]!;
    assert.match(notification.held.summary, /archive-primary/);
    assert.doesNotMatch(JSON.stringify(notification), /nomo-secret-sentinel/);
    assert.equal("args" in notification.held, false);
    assert.deepEqual(broker.review(record.holdId)?.binding, binding);
    assert.equal(broker.review(record.holdId)?.summary, notification.held.summary);
  });

  test("register binds the exact hold operation and policy version", () => {
    const queue = new HoldQueue();
    const first = approvalBinding("operation-1", "a");
    const second = approvalBinding("operation-2", "c");
    void queue.hold({ ...heldCall(), binding: first } as unknown as Parameters<HoldQueue["hold"]>[0], 60);
    void queue.hold({ ...heldCall(), binding: second } as unknown as Parameters<HoldQueue["hold"]>[0], 60);
    const broker = new ApprovalBroker();

    const record = broker.register(queue, policyCall(), "h0002");

    assert.equal(record.holdId, "h0002");
    assert.deepEqual((record as { binding?: unknown }).binding, second);
    assert.deepEqual((broker.listPending()[0] as { binding?: unknown } | undefined)?.binding, second);
  });

  test("persists the exact operation binding in owner-only pending state", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "nomo-hold-binding-"));
    chmodSync(dir, 0o700);
    const queue = new HoldQueue();
    const binding = approvalBinding("operation-persisted", "d");
    void queue.hold({
      ...heldCall(),
      args: { bucket: "archive-private", apiKey: "nomo-secret-sentinel" },
      binding,
    } as unknown as Parameters<HoldQueue["hold"]>[0], 60);
    const broker = new ApprovalBroker({ stateDir: dir });
    t.after(() => {
      queue.close();
      broker.close();
      rmSync(dir, { recursive: true, force: true });
    });

    broker.register(queue, policyCall());

    assert.deepEqual(loadPending(dir)[0]?.binding, binding);
    const pendingPath = join(dir, "pending.json");
    const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as Array<Record<string, unknown>>;
    assert.doesNotMatch(JSON.stringify(pending), /nomo-secret-sentinel/);
    assert.equal("args" in pending[0]!, false);
    assert.equal(pending[0]!.operationSummary, '{"apiKey":"[redacted]","bucket":"archive-private"}');
    pending[0]!.args = { apiKey: "nomo-secret-sentinel" };
    writeFileSync(pendingPath, JSON.stringify(pending));
    assert.throws(() => loadPending(dir), /invalid pending approvals file/);
    delete pending[0]!.args;
    const pendingCall = pending[0]!.call as Record<string, unknown>;
    pendingCall.arguments = { apiKey: "nomo-secret-sentinel" };
    writeFileSync(pendingPath, JSON.stringify(pending));
    assert.throws(() => loadPending(dir), /invalid pending approvals file/);
    delete pendingCall.arguments;
    pending[0]!.binding = { ...binding, operationDigest: "bad" };
    writeFileSync(pendingPath, JSON.stringify(pending));
    assert.throws(() => loadPending(dir), /invalid pending approvals file/);
  });

  test("bound approvals ignore caller-supplied identity and record the local operator", async () => {
    const queue = new HoldQueue();
    const binding = approvalBinding("operation-3", "e");
    const promise = queue.hold({
      ...heldCall(),
      binding,
    } as unknown as Parameters<HoldQueue["hold"]>[0], 60);
    const broker = new ApprovalBroker();
    const record = broker.register(queue, policyCall());

    assert.equal(broker.decide(record.holdId, { kind: "approved", by: "spoofed" }), true);
    const resolution = await promise;

    assert.deepEqual(resolution.outcome, {
      kind: "released",
      release: { kind: "approved", by: binding.operatorId },
    });
    assert.equal(broker.get(record.holdId)?.by, binding.operatorId);
  });

  test("unbound decisions ignore caller-supplied operator identity", async () => {
    const queue = new HoldQueue();
    const promise = queue.hold(heldCall(), 60);
    const broker = new ApprovalBroker();
    const record = broker.register(queue, policyCall());

    assert.equal(broker.decide(record.holdId, {
      kind: "denied",
      by: "forged-operator",
      reason: "reviewed locally",
    }), true);
    const resolution = await promise;

    assert.deepEqual(resolution.outcome, {
      kind: "released",
      release: { kind: "denied", by: verifiedLocalOperatorId() },
    });
    assert.equal(broker.get(record.holdId)?.by, verifiedLocalOperatorId());
  });

  test("a hold bound to another OS account cannot be released locally", async () => {
    const queue = new HoldQueue();
    const binding = { ...approvalBinding("operation-4", "f"), operatorId: "other-operator" };
    const promise = queue.hold({
      ...heldCall(),
      binding,
    } as unknown as Parameters<HoldQueue["hold"]>[0], 60);

    assert.equal(queue.resolve("h0001", { kind: "approved" }, "other-operator"), false);
    assert.equal(queue.resolve("h0001", { kind: "approved" }, verifiedLocalOperatorId()), false);
    assert.equal(queue.list().length, 1);
    queue.close();
    assert.equal((await promise).outcome.kind, "expired");
  });

  test("decide routes approval to the hold queue", async () => {
    const queue = new HoldQueue();
    const promise = queue.hold(heldCall(), 60);
    const broker = new ApprovalBroker();
    const record = broker.register(queue, policyCall());

    assert.equal(broker.decide(record.holdId, { kind: "approved", by: "ada" }), true);
    const resolution = await promise;

    assert.equal(resolution.outcome.kind, "released");
    assert.deepEqual(resolution.outcome, { kind: "released", release: { kind: "approved" } });
    assert.equal(broker.get(record.holdId)?.status, "approved");
    assert.equal(broker.get(record.holdId)?.by, verifiedLocalOperatorId());
  });

  test("decide routes denial to the hold queue", async () => {
    const queue = new HoldQueue();
    const promise = queue.hold(heldCall(), 60);
    const broker = new ApprovalBroker();
    const record = broker.register(queue, policyCall());

    assert.equal(broker.decide(record.holdId, { kind: "denied", by: "bea", reason: "too broad" }), true);
    const resolution = await promise;

    assert.equal(resolution.outcome.kind, "released");
    assert.deepEqual(resolution.outcome, {
      kind: "released",
      release: { kind: "denied", by: verifiedLocalOperatorId() },
    });
    assert.equal(broker.get(record.holdId)?.by, verifiedLocalOperatorId());
    assert.equal(broker.get(record.holdId)?.status, "denied");
    assert.equal(broker.get(record.holdId)?.reason, "too broad");
  });

  test("expire resolves due holds as expired without sleeping", async () => {
    const queue = new HoldQueue();
    const promise = queue.hold(heldCall(), 60);
    const broker = new ApprovalBroker();
    const record = broker.register(queue, policyCall());

    const expired = broker.expire(record.expiresAt);
    const resolution = await promise;

    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.status, "expired");
    assert.equal(resolution.outcome.kind, "expired");
    assert.equal(broker.get(record.holdId)?.status, "expired");
  });

  test("denied approvals produce the readable hold error", async () => {
    const queue = new HoldQueue();
    const promise = queue.hold(heldCall(), 60);
    const broker = new ApprovalBroker();
    const record = broker.register(queue, policyCall());

    broker.decide(record.holdId, { kind: "denied", by: "casey" });
    const resolution = await promise;
    const body = holdErrorMessage(resolution.call, resolution.outcome, "hold");

    assert.match(body.message, /was denied by a human/);
    assert.match(body.message, /Do not retry the same call/);
    assert.equal(body.data.result, "denied");
  });
});

function approvalBinding(operationId: string, digestPrefix: string) {
  return {
    operationId,
    operationDigest: digestPrefix.repeat(64),
    policyVersion: 7,
    policyDigest: "b".repeat(64),
    operatorId: verifiedLocalOperatorId(),
    principalId: "fixture-principal",
    agentId: "fixture-agent",
    runId: "fixture-run",
    workspaceId: "fixture-workspace",
    upstreamId: "fixture-upstream",
    schemaDigest: "d".repeat(64),
  };
}

function policyCall(): PolicyCall {
  return {
    tool: "aws.s3.bucket.delete",
    connector: "aws",
    workspace: "test",
    klass: "r3",
    blastRadius: 3,
  };
}

function heldCall(): Parameters<HoldQueue["hold"]>[0] {
  return {
    tool: "aws.s3.bucket.delete",
    klass: "r3",
    blastRadius: 3,
    ruleIndex: 0,
    rationale: "approval required",
    args: { n: 3 },
    notify: ["cli"],
  };
}

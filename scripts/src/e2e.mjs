#!/usr/bin/env node
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";

import { listenControlPlane } from "../../apps/control-plane/api/server.ts";
import { keyProviderFromPkcs8 } from "../../packages/ledger/src/sign.ts";
import { ApprovalBroker } from "../../packages/policy/src/approvals.ts";
import { pumpApprovals } from "../../packages/proxy/src/approval-loop.ts";
import { runProxy } from "../../packages/proxy/src/bin.ts";
import { legacyArgsDigest } from "../../packages/proxy/src/forward/legacy-binding.ts";
import { Workbench } from "../../packages/workbench/src/index.ts";
import { identityE2eTools } from "../../fixtures/identity-e2e-tools.mjs";

const passLines = [];
const failures = [];

function pass(name) {
  const line = `PASS ${name}`;
  passLines.push(line);
  console.log(line);
}

function fail(name, error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  const line = `FAIL ${name}: ${detail}`;
  failures.push(line);
  console.error(line);
}

async function check(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    fail(name, error);
  }
}

class ScriptInput {
  constructor() {
    this.lines = [];
    this.waiters = [];
    this.done = false;
  }

  push(message) {
    this.pushLine(JSON.stringify(message));
  }

  pushLine(line) {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: line, done: false });
      return;
    }
    this.lines.push(line);
  }

  end() {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next() {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve({ value: line, done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return() {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForAsync(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function strictFactsPath() {
  const raw = JSON.parse(await readFile("fixtures/facts.json", "utf8"));
  const facts = {};
  for (const [name, value] of Object.entries(raw)) {
    facts[name] = { value, verifiedAt: "2026-09-08T00:00:00Z", source: "fixture" };
  }
  const dir = await mkdtemp(join(tmpdir(), "void-e2e-"));
  const path = join(dir, "facts.json");
  await writeFile(path, `${JSON.stringify({ facts })}\n`);
  return path;
}

function textFrom(response) {
  return response?.result?.content?.[0]?.text;
}

async function runApiPass(factsPath) {
  const input = new ScriptInput();
  const output = [];
  const errors = [];
  let holdQueue = null;
  const ledgerDir = await mkdtemp(join(tmpdir(), "void-e2e-ledger-"));
  const running = runProxy({
    upstreamCommand: ["node", "fixtures/e2e-server.mjs"],
    policyPath: "fixtures/e2e-policy.yaml",
    factsPath,
    posture: "fail-closed",
    ledgerDir,
    workspace: "e2e",
    input,
    output(line) { output.push(JSON.parse(line)); },
    error(line) { errors.push(line); process.stderr.write(`${line}\n`); },
    onHold(queue) { holdQueue = queue; },
  });

  await check("api initialize version", async () => {
    input.push({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    await waitFor(() => output.length >= 1, "initialize response");
    assert.equal(output[0].result.protocolVersion, "2025-06-18");
  });

  await check("api tools/list fixture tools", async () => {
    input.push({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await waitFor(() => output.length >= 2, "tools/list response");
    assert.deepEqual(
      output[1].result.tools.map((tool) => tool.name),
      ["echo", "orders_delete", "orders_update"],
    );
  });

  await check("api echo forwards result", async () => {
    input.push({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hello void" } } });
    await waitFor(() => output.length >= 3, "echo response");
    assert.equal(textFrom(output[2]), "hello void");
  });

  let heldId = "";
  await check("api orders_delete parks without response", async () => {
    input.push({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "orders_delete", arguments: { where: "status = stale", rows: 2 } } });
    const held = await waitFor(() => holdQueue?.list()?.[0], "held call");
    heldId = held.id;
    process.stderr.write(`held ${heldId}\n`);
    await tick();
    await tick();
    assert.equal(output.length, 3);
  });

  await check("api direct test queue releases held fixture result", async () => {
    assert.equal(holdQueue.resolve(heldId, { kind: "approved" }), true);
    await waitFor(() => output.length >= 4, "approved call response");
    assert.equal(textFrom(output[3]), "deleted 2");
    assert.equal(output[3].result.count, 2);
  });

  await check("api orders_update is denied before dispatch", async () => {
    input.push({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "orders_update", arguments: { where: "status = stale", status: "closed" } },
    });
    const response = await waitFor(
      () => output.find((message) => message.id === 5),
      "denied write response",
    );
    assert.match(response.error?.message ?? "", /orders_update.*was denied/);
    assert.match(response.error?.message ?? "", /Do not retry/);
  });

  await check("api no unexpected stderr", async () => {
    assert.deepEqual(errors, []);
  });

  await check("api ledger recorded every decided call", async () => {
    const ledgerFile = join(ledgerDir, "e2e.jsonl");
    const raw = await readFile(ledgerFile, "utf8");
    const entries = raw.trim().split("\n").map((line) => JSON.parse(line));
    // The direct queue resolution is only a proxy test seam, not operator
    // approval evidence. Match each input call to its digest and operation id.
    const expectedCalls = [
      { tool: "echo", args: { text: "hello void" } },
      { tool: "orders_delete", args: { where: "status = stale", rows: 2 } },
      { tool: "orders_update", args: { where: "status = stale", status: "closed" } },
    ];
    const operationIds = [];
    for (const call of expectedCalls) {
      const digest = await legacyArgsDigest(call.args);
      const matching = entries.filter(
        (entry) => entry.body?.tool === call.tool && entry.body?.argsDigest === digest,
      );
      assert.ok(matching.length > 0, `ledger has no entry for ${call.tool}`);
      const ids = new Set(matching.map((entry) => entry.body?.operationId).filter(Boolean));
      assert.equal(ids.size, 1, `ledger does not consistently correlate ${call.tool}`);
      operationIds.push([...ids][0]);
    }
    assert.equal(new Set(operationIds).size, expectedCalls.length);
    assert.ok(entries.some(
      (entry) => entry.body?.tool === "orders_update" && entry.body?.decision === "deny",
    ));
    assert.ok(entries.some(
      (entry) => entry.body?.tool === "orders_delete" && entry.body?.decision === "hold:approved",
    ));
    assert.ok(entries.every((entry) => entry.body?.argsDigest?.length === 64));
    assert.ok(entries.every((entry) => entry.body?.args === undefined));
    assert.ok(entries.every((entry) => typeof entry.prev_hash === "string"));
  });

  input.end();
  await running;
}

async function runBinaryObservePass(factsPath) {
  // Dispatch evidence is mandatory on every forwarded call, observe posture
  // included: without a ledger directory the proxy answers
  // "durable dispatch evidence requires a ledger directory" instead of the
  // upstream result, so the binary pass opens a store exactly like the api pass.
  const ledgerDir = await mkdtemp(join(tmpdir(), "void-e2e-ledger-"));
  const child = spawn(process.execPath, [
    "packages/proxy/bin/void-proxy.mjs",
    "--upstream", process.execPath,
    "--args", "fixtures/e2e-server.mjs",
    "--policy", "fixtures/e2e-policy.yaml",
    "--facts", factsPath,
    "--posture", "observe",
    "--ledger-dir", ledgerDir,
  ], { stdio: ["pipe", "pipe", "pipe"] });

  const output = [];
  const errors = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of chunk.split("\n")) if (line.trim() !== "") output.push(JSON.parse(line));
  });
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.split("\n")) if (line.trim() !== "") errors.push(line);
  });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  await check("binary observe initialize", async () => {
    send({ jsonrpc: "2.0", id: 11, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    await waitFor(() => output.length >= 1, "binary initialize response");
    assert.equal(output[0].result.protocolVersion, "2025-06-18");
  });

  await check("binary observe echo", async () => {
    send({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "echo", arguments: { text: "observe echo" } } });
    await waitFor(() => output.length >= 2, "binary echo response");
    assert.equal(textFrom(output[1]), "observe echo");
  });

  await check("binary observe orders_delete forwards", async () => {
    send({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "orders_delete", arguments: { where: "status = stale", rows: 2 } } });
    await waitFor(() => output.length >= 3, "binary observe delete response");
    assert.equal(textFrom(output[2]), "deleted 2");
    assert.match(errors.join("\n"), /observe: hold verdict for orders_delete forwarded/);
  });

  child.stdin.end();
  const exit = await new Promise((resolve) => child.on("close", (code) => resolve(code)));
  await check("binary observe exits zero", async () => {
    assert.equal(exit, 0);
  });
}

async function runLocalIdentityPass(factsPath) {
  const directory = await mkdtemp(join(tmpdir(), "void-identity-e2e-"));
  const policyPath = join(directory, "policy.yaml");
  const ledgerDir = join(directory, "ledger");
  const tracePath = join(directory, "target.jsonl");
  const upstreamId = "local-identity-e2e";
  const taskPrompt = "Store one object, delete the demo bucket with approval, then try a denied object delete.";
  const plannedCalls = [
    { tool: "aws.s3.object.put", args: { key: "demo.txt", body: "fixture-content" } },
    { tool: "aws.s3.bucket.delete", args: { bucket: "nomo-demo" } },
    { tool: "aws.s3.object.delete", args: { bucket: "nomo-demo", key: "denied.txt" } },
  ];
  const policy = [
    "version: 1",
    "rules:",
    "  - match:",
    "      tool: aws.s3.bucket.delete",
    "    decision: hold",
    "    seconds: 30",
    "    notify: [cli]",
    "    rationale: disposable bucket deletion requires approval",
    "  - match:",
    "      tool: aws.s3.object.delete",
    "    decision: deny",
    "    rationale: fixture denial case",
    "  - match: {}",
    "    decision: deny",
    "    rationale: only explicit fixture operations are permitted",
    "",
  ].join("\n");
  await writeFile(policyPath, policy, { mode: 0o600 });
  await writeFile(tracePath, "", { mode: 0o600 });

  let batchSent = false;
  const providerBodies = [];
  const providerFetch = async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const bodyText = String(init?.body ?? "{}");
    providerBodies.push(bodyText);
    if (batchSent)
      return Response.json({ choices: [{ message: { role: "assistant", content: "Demo task complete" } }] });
    batchSent = true;
    const request = JSON.parse(bodyText);
    const calls = plannedCalls.map((call, index) => {
      const tool = request.tools?.find((candidate) =>
        String(candidate.function?.description ?? "").includes(call.tool),
      );
      assert.ok(tool, `provider catalog omitted ${call.tool}`);
      return {
        id: `identity-call-${index + 1}`,
        type: "function",
        function: {
          name: tool.function.name,
          arguments: JSON.stringify(call.args),
        },
      };
    });
    return Response.json({
      choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }],
    });
  };

  let app;
  let api;
  let broker;
  let approvalPump;
  let taskPromise;
  let taskSettled = false;
  let holdAttached = false;
  const approvalErrors = [];
  let pendingApiText = "";
  try {
    app = new Workbench({ VOID_DATA_DIR: join(directory, "workbench") }, providerFetch);
    await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
    broker = new ApprovalBroker({ stateDir: join(directory, "approvals") });
    approvalPump = pumpApprovals(broker, undefined, {
      onError(error) {
        approvalErrors.push(error instanceof Error ? error.message : String(error));
      },
    });
    api = await listenControlPlane({ workbench: app, approvals: broker, env: {} });
    const apiOrigin = `http://127.0.0.1:${api.port}`;
    const putTool = identityE2eTools.find((tool) => tool.name === "aws.s3.object.put");
    assert.ok(putTool);
    const putSchemaDigest = await legacyArgsDigest(putTool.inputSchema);
    taskPromise = app.runLocalHarnessTask({
      upstreamId,
      prompt: taskPrompt,
      toolScope: identityE2eTools.map((tool) => tool.name),
      facts: { "bucket.versioning": "Enabled", "bucket.mfa_delete": "off" },
      learning: { enabled: false },
      proxy: {
        upstreamCommand: [process.execPath, "fixtures/e2e-server.mjs", "--identity"],
        upstreamEnv: { NOMO_E2E_TRACE: tracePath },
        policyPath,
        factsPath,
        posture: "fail-closed",
        ledgerDir,
        keyProvider: keyProviderFromPkcs8(
          generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }),
        ),
        operationProfiles: [{
          profileId: "e2e-demo-object-put-v1",
          upstreamId,
          tool: putTool.name,
          schemaDigest: putSchemaDigest,
          assess: ({ args }) => args.key === "demo.txt" && args.body === "fixture-content"
            ? { effect: "write", risk: "low", fastPath: "allow" }
            : undefined,
        }],
        onHold(queue) {
          holdAttached = true;
          return approvalPump.onHold(queue);
        },
      },
    });
    void taskPromise.catch(() => {});

    let pendingPayload;
    const workbenchPending = await waitForAsync(async () => {
      const response = await fetch(`${apiOrigin}/api/approvals`);
      assert.equal(response.status, 200);
      pendingPayload = await response.json();
      pendingApiText = JSON.stringify(pendingPayload);
      return pendingPayload.approvals?.find(
        (approval) => approval.call?.tool === "aws.s3.bucket.delete" && !approval.binding,
      );
    }, "Workbench bucket delete confirmation");
    const run = app.list().find((session) => session.status === "running");
    assert.ok(run, "Workbench task is not running while the first hold is pending");
    const beforeApproval = (await readFile(tracePath, "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

    await check("Workbench hold pauses bucket delete before proxy approval", async () => {
      assert.equal(holdAttached, true);
      assert.equal(workbenchPending.status, "pending");
      assert.ok(workbenchPending.holdId.includes(":"));
      assert.equal(workbenchPending.binding, undefined);
      assert.deepEqual(beforeApproval.map((entry) => entry.tool), ["aws.s3.object.put"]);
    });

    const workbenchDecisionResponse = await fetch(
      `${apiOrigin}/api/approvals/${encodeURIComponent(workbenchPending.holdId)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "approved", by: "fixture-client", reason: "continue to proxy review" }),
      },
    );
    const workbenchDecisionBody = await workbenchDecisionResponse.json();
    assert.equal(workbenchDecisionResponse.status, 200);
    assert.deepEqual(workbenchDecisionBody, { ok: true, result: true });

    const pending = await waitForAsync(async () => {
      const response = await fetch(`${apiOrigin}/api/approvals`);
      assert.equal(response.status, 200);
      pendingPayload = await response.json();
      return pendingPayload.approvals?.find(
        (approval) => approval.call?.tool === "aws.s3.bucket.delete" &&
          approval.binding?.runId === run.runId,
      );
    }, "identity-bound proxy bucket delete hold");
    pendingApiText += JSON.stringify(pendingPayload);
    const bucketDeleteTool = identityE2eTools.find(
      (tool) => tool.name === "aws.s3.bucket.delete",
    );
    assert.ok(bucketDeleteTool);
    const bucketDeleteSchemaDigest = await legacyArgsDigest(bucketDeleteTool.inputSchema);

    await check("proxy hold binds operation to the active Workbench run", async () => {
      assert.equal(pending.status, "pending");
      assert.equal(pending.call.tool, "aws.s3.bucket.delete");
      assert.ok(pending.holdId.startsWith("h"));
      assert.equal(app.list().length, 1);
      assert.equal(pending.binding?.runId, run.runId);
      assert.equal(pending.binding?.workspaceId, run.workspace);
      assert.equal(pending.binding?.upstreamId, upstreamId);
      assert.equal(pending.binding?.principalId, "workbench-local");
      assert.equal(pending.binding?.agentId, "workbench-local-agent");
      assert.equal(pending.binding?.policyVersion, 1);
      assert.equal(pending.binding?.schemaDigest, bucketDeleteSchemaDigest);
      assert.match(pending.binding?.operationDigest ?? "", /^[a-f0-9]{64}$/);
      assert.match(pending.binding?.policyDigest ?? "", /^[a-f0-9]{64}$/);
      assert.equal(typeof pending.binding?.operatorId, "string");
      assert.equal(broker.list().find((record) => record.holdId === pending.holdId)?.status, "pending");
      assert.deepEqual(beforeApproval.map((entry) => entry.tool), ["aws.s3.object.put"]);
    });

    const decisionResponse = await fetch(
      `${apiOrigin}/api/approvals/${encodeURIComponent(pending.holdId)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "approved", by: "fixture-client", reason: "local identity review" }),
      },
    );
    const decisionBody = await decisionResponse.json();
    assert.equal(decisionResponse.status, 200);
    assert.deepEqual(decisionBody, { ok: true, result: true });
    const result = await taskPromise;
    taskSettled = true;
    const afterApproval = (await readFile(tracePath, "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const brokerRecord = broker.list().find((record) => record.holdId === pending.holdId);
    const proxyRows = (await readFile(join(ledgerDir, `${result.identity.workspaceId}.jsonl`), "utf8"))
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const entries = proxyRows.map((row) => row.body);

    await check("control-plane approval dispatches the identity-bound write", async () => {
      assert.deepEqual(afterApproval.map((entry) => entry.tool), [
        "aws.s3.object.put",
        "aws.s3.bucket.delete",
      ]);
      assert.equal(brokerRecord?.status, "approved");
      assert.equal(brokerRecord?.by, pending.binding.operatorId);
      assert.equal(brokerRecord?.reason, "local identity review");
      assert.equal(brokerRecord?.binding?.runId, result.identity.runId);
      assert.equal(result.identity.runId, pending.binding.runId);
      assert.equal(result.identity.workspaceId, pending.binding.workspaceId);
      assert.equal(result.identity.upstreamId, upstreamId);
      assert.equal(result.identity.expiresAt - result.identity.issuedAt, 60_000);
    });

    await check("proxy ledger correlates allowed, approved and denied calls", async () => {
      const operationIds = [];
      for (const call of plannedCalls) {
        const digest = await legacyArgsDigest(call.args);
        const matching = proxyRows.filter(
          (row) => row.body?.tool === call.tool && row.body?.argsDigest === digest,
        );
        assert.ok(matching.length > 0, `ledger has no evidence for ${call.tool}`);
        const ids = new Set(matching.map((row) => row.body?.operationId).filter(Boolean));
        assert.equal(ids.size, 1, `ledger does not correlate ${call.tool}`);
        operationIds.push([...ids][0]);
      }
      assert.equal(new Set(operationIds).size, plannedCalls.length);
      assert.equal(operationIds[1], pending.binding.operationId);
      assert.ok(entries.some((entry) =>
        entry.tool === "aws.s3.object.put" &&
        entry.phase === "dispatch" &&
        entry.decision === "dispatch:started" &&
        entry.profileId === "e2e-demo-object-put-v1" &&
        entry.effect === "write" && entry.risk === "low" && entry.fastPath === "allow",
      ));
      assert.ok(entries.some((entry) =>
        entry.tool === "aws.s3.bucket.delete" && entry.decision === "hold:approved",
      ));
      assert.ok(entries.some((entry) =>
        entry.tool === "aws.s3.object.delete" && entry.decision === "deny",
      ));
      assert.ok(approvalErrors.length === 0, approvalErrors.join("\n"));
    });

    await check("local grant is scoped and absent from model, approval and proxy ledger", async () => {
      assert.deepEqual([...result.identity.toolScope].sort(), identityE2eTools.map((tool) => tool.name).sort());
      assert.equal(app.list().length, 1);
      assert.equal(app.get(result.sessionId)?.runId, result.identity.runId);
      assert.equal(providerBodies.join("\n").includes(result.grantToken), false);
      assert.equal(pendingApiText.includes(result.grantToken), false);
      assert.equal(JSON.stringify(proxyRows).includes(result.grantToken), false);
      const targetTrace = await readFile(tracePath, "utf8");
      const targetCalls = targetTrace.trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(targetCalls.length > 0, "the disposable target recorded tool calls");
      assert.ok(
        targetCalls.every((call) => typeof call.arguments === "object" && call.arguments !== null),
        "the target trace includes tool arguments for the token-leak check",
      );
      assert.equal(targetTrace.includes(result.grantToken), false);
      assert.ok(entries.every((entry) => entry.args === undefined));
    });
  } finally {
    if (!taskSettled) approvalPump?.stop();
    if (taskPromise) await taskPromise.catch(() => {});
    approvalPump?.stop();
    await api?.close().catch(() => {});
    await app?.shutdown().catch(() => {});
    if (!approvalPump) broker?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function runNoLedgerStartupPass(factsPath) {
  await check("fail-closed startup refuses to run without a ledger directory", async () => {
    await assert.rejects(
      runProxy({
        upstreamCommand: [process.execPath, "fixtures/e2e-server.mjs"],
        policyPath: "fixtures/e2e-policy.yaml",
        factsPath,
        posture: "fail-closed",
        workspace: "missing-ledger",
        input: new ScriptInput(),
        shutdownSignals: false,
        output() {},
        error() {},
      }),
      /fail-closed posture requires a ledger directory/,
    );
  });
}

const factsPath = await strictFactsPath();
await runApiPass(factsPath);
await runBinaryObservePass(factsPath);
await check("identity Workbench approval rehearsal completes", () => runLocalIdentityPass(factsPath));
await runNoLedgerStartupPass(factsPath);

if (failures.length > 0) process.exitCode = 1;

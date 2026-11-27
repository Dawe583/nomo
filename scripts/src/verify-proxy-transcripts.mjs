#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const rootPath = fileURLToPath(new URL("../..", import.meta.url));

/** Focused proxy transcript proof: exact allowed-tool responses plus upstream dispatch evidence for held writes. */
export async function verifyProxyTranscripts() {
  const root = await mkdtemp(join(tmpdir(), "nomo-proxy-transcripts-"));
  try {
    const direct = await runDirect(root);
    const proxied = await runProxied(root);
    assert.deepEqual(proxied.list, direct.list, "proxied tools/list result differs from direct upstream result");
    assert.deepEqual(proxied.echo, direct.echo, "proxied echo result differs from direct upstream result");
    assert.equal(proxied.initialize.protocolVersion, direct.initialize.protocolVersion);
    return {
      directInitialize: direct.initialize,
      proxiedInitialize: proxied.initialize,
      listCompared: true,
      echoCompared: true,
      approvedUpstreamCalls: proxied.deleteCallsAfterApproval,
      deleteCallsAfterExpiry: proxied.deleteCallsAfterExpiry,
      expiredResult: proxied.expiredResult,
      ledgerDecisions: proxied.ledgerDecisions,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runDirect(root) {
  const log = join(root, "direct-upstream.jsonl");
  const child = spawnJson(process.execPath, ["fixtures/e2e-server.mjs", log], {
    PATH: process.env.PATH ?? "",
    NOMO_E2E_FIXTURE_LOG: log,
  });
  try {
    send(child, message(1, "initialize"));
    send(child, message(2, "tools/list"));
    send(child, message(3, "tools/call", { name: "echo", arguments: { text: "transcript equality" } }));
    const initialize = (await waitResponse(child, 1)).result;
    const list = (await waitResponse(child, 2)).result;
    const echo = (await waitResponse(child, 3)).result;
    child.child.stdin.end();
    await closed(child.child);
    return { initialize, list, echo };
  } finally {
    child.child.kill();
  }
}

async function runProxied(root) {
  const home = join(root, "home");
  const ledgerDir = join(root, "ledger");
  const approvalsDir = join(root, "approvals");
  const log = join(root, "proxy-upstream.jsonl");
  const workspace = "proxy-transcripts";
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NOMO_WORKSPACE: workspace,
    NOMO_E2E_FIXTURE_LOG: log,
  };
  const facts = join(root, "facts.json");
  const rawFacts = JSON.parse(await readFile(join(rootPath, "fixtures/facts.json"), "utf8"));
  const factsWrapped = {};
  for (const [name, value] of Object.entries(rawFacts)) factsWrapped[name] = { value, verifiedAt: "2026-09-08T00:00:00Z", source: "fixture" };
  await writeFile(facts, `${JSON.stringify({ facts: factsWrapped })}\n`);
  const policy = join(root, "policy.yaml");
  await writeFile(policy, `version: 1\nrules:\n  - match:\n      tool: echo\n      class: unknown\n    decision: allow\n  - match:\n      tool: orders_delete\n    decision: hold\n    seconds: 2\n    notify: [cli]\n    rationale: destructive fixture tool requires approval\n  - match: {}\n    decision: deny\n    rationale: only fixture tools are allowed\n`);

  const proxy = spawnJson(process.execPath, [
    "packages/proxy/bin/nomo-proxy.mjs",
    "--upstream", process.execPath,
    "--args", `fixtures/e2e-server.mjs,${log}`,
    "--policy", policy,
    "--facts", facts,
    "--posture", "fail-closed",
    "--ledger-dir", ledgerDir,
    "--approvals-dir", approvalsDir,
    "--workspace", workspace,
  ], env);
  try {
    send(proxy, message(1, "initialize"));
    send(proxy, message(2, "tools/list"));
    send(proxy, message(3, "tools/call", { name: "echo", arguments: { text: "transcript equality" } }));
    const initialize = (await waitResponse(proxy, 1)).result;
    const list = (await waitResponse(proxy, 2)).result;
    const echo = (await waitResponse(proxy, 3)).result;

    send(proxy, message(4, "tools/call", { name: "orders_delete", arguments: { where: "status = stale", rows: 2 } }));
    const firstHoldId = await waitFor(async () => {
      try {
        const pending = JSON.parse(await readFile(join(approvalsDir, "pending.json"), "utf8"));
        return pending[0]?.holdId || false;
      } catch { return false; }
    }, "first pending hold");
    assert.equal(await upstreamDeleteCalls(log), 0, "held write reached upstream before approval");
    const approval = await runCli(["approve", firstHoldId, "--by", "transcript-test", "--reason", "proof", "--dir", approvalsDir], env);
    assert.equal(approval.code, 0, `${approval.stdout}\n${approval.stderr}`);
    const approved = await waitResponse(proxy, 4, 500);
    assert.equal(approved.result?.content?.[0]?.text, "deleted 2");
    const deleteCallsAfterApproval = await waitFor(async () => {
      const count = await upstreamDeleteCalls(log);
      return count === 1 ? count : false;
    }, "approved upstream dispatch");

    send(proxy, message(5, "tools/call", { name: "orders_delete", arguments: { where: "status = stale", rows: 2 } }));
    const expired = await waitResponse(proxy, 5, 700);
    const expiredResult = expired.error?.data?.result;
    assert.equal(expiredResult, "expired");
    await delay(100);
    const deleteCallsAfterExpiry = await upstreamDeleteCalls(log);
    assert.equal(deleteCallsAfterExpiry, 1, "expired held write reached upstream");

    proxy.child.stdin.end();
    assert.equal(await closed(proxy.child), 0);
    assert.deepEqual(proxy.errors, []);
    const ledgerText = await readFile(join(ledgerDir, `${workspace}.jsonl`), "utf8");
    const ledgerDecisions = ledgerText.trim().split("\n").map((line) => JSON.parse(line).body?.decision).filter(Boolean);
    assert.ok(ledgerDecisions.includes("hold:approved"));
    assert.ok(ledgerDecisions.includes("hold:expired"));
    return { initialize, list, echo, deleteCallsAfterApproval, deleteCallsAfterExpiry, expiredResult, ledgerDecisions };
  } finally {
    proxy.child.kill();
  }
}

function message(id, method, params = {}) {
  if (method === "initialize") return { jsonrpc: "2.0", id, method, params: { protocolVersion: "2025-06-18", capabilities: {} } };
  return { jsonrpc: "2.0", id, method, params };
}

function spawnJson(command, args, env) {
  const child = spawn(command, args, { cwd: rootPath, env, stdio: ["pipe", "pipe", "pipe"] });
  const output = [];
  const errors = [];
  let buffer = "";
  let errorBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end === -1) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) output.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => {
    errorBuffer += chunk;
    for (;;) {
      const end = errorBuffer.indexOf("\n");
      if (end === -1) break;
      const line = errorBuffer.slice(0, end);
      errorBuffer = errorBuffer.slice(end + 1);
      if (line.trim()) errors.push(line);
    }
  });
  return { child, output, errors };
}

function send(processHandle, value) {
  processHandle.child.stdin.write(`${JSON.stringify(value)}\n`);
}

async function waitResponse(processHandle, id, attempts = 300) {
  return waitFor(() => processHandle.output.find((message) => message.id === id) ?? false, `response id ${id}`, attempts, 10);
}

async function waitFor(predicate, label, attempts = 300, ms = 10) {
  for (let index = 0; index < attempts; index += 1) {
    const value = await predicate();
    if (value) return value;
    await delay(ms);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function upstreamDeleteCalls(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.method === "tools/call" && entry.tool === "orders_delete").length;
  } catch { return 0; }
}

async function runCli(args, env) {
  const child = spawn(process.execPath, ["packages/cli/bin/nomo.mjs", ...args], { cwd: rootPath, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { code: await closed(child), stdout, stderr };
}

function closed(child) {
  return new Promise((resolve) => child.on("close", (code) => resolve(code ?? 0)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyProxyTranscripts();
    console.log(JSON.stringify({ passed: true, ...result }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}

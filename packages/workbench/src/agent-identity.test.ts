import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Workbench } from "./index.ts";
import { isolatedWorkbench } from "./test-fixture.ts";
import {
  LocalAgentIdentityIssuer,
  type LocalAgentGrantBinding,
  type LocalAgentGrantRequest,
} from "./agent-identity.ts";

type Binding = LocalAgentGrantBinding;
type Request = LocalAgentGrantRequest;

const binding: Binding = {
  principalId: "workbench-local",
  workspaceId: "workspace-1",
  agentId: "registered-agent-1",
  runId: "run-1",
  upstreamId: "fixture-mcp",
  toolScope: ["write", "read"],
};
const request: Request = {
  audience: "nomo-inbound-proxy",
  upstreamId: "fixture-mcp",
  toolName: "read",
};

test("opaque grant returns stored identity, not caller supplied identity fields", () => {
  let now = 1000;
  const issuer = new LocalAgentIdentityIssuer({ now: () => now, wallNow: () => now });
  const grant = issuer.issue(binding);
  assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(grant.token, /workspace-1|registered-agent-1|run-1/);
  assert.equal(grant.expiresAt, 61000);

  const forgedRequest = {
    ...request,
    principalId: "caller-principal",
    workspaceId: "caller-workspace",
    agentId: "caller-agent",
    runId: "caller-run",
  };
  const verified = issuer.validate(grant.token, forgedRequest);
  assert.deepEqual(verified, {
    ...binding,
    toolScope: ["read", "write"],
    issuer: "nomo-workbench-local",
    audience: "nomo-inbound-proxy",
    issuedAt: 1000,
    expiresAt: 61000,
  });
  assert.equal(JSON.stringify(verified).includes(grant.token), false);
  assert.equal(
    issuer.validate(grant.token, { ...request, audience: "wrong-audience" }),
    null,
  );
  assert.equal(
    issuer.validate(grant.token, { ...request, upstreamId: "other-upstream" }),
    null,
  );
  assert.equal(
    issuer.validate(grant.token, { ...request, toolName: "delete" }),
    null,
  );
  assert.equal(
    issuer.validate(grant.token, null as unknown as Request),
    null,
  );

  now = grant.expiresAt;
  assert.equal(issuer.validate(grant.token, request), null);
});

test("authenticates a grant for its upstream without authorizing a tool", () => {
  const issuer = new LocalAgentIdentityIssuer({ now: () => 5000, wallNow: () => 5000 });
  const grant = issuer.issue(binding);

  assert.deepEqual(
    issuer.authenticate(grant.token, {
      audience: "nomo-inbound-proxy",
      upstreamId: "fixture-mcp",
    })?.toolScope,
    ["read", "write"],
  );
  assert.equal(
    issuer.authenticate(grant.token, {
      audience: "wrong-audience",
      upstreamId: "fixture-mcp",
    }),
    null,
  );
  assert.equal(
    issuer.authenticate(grant.token, {
      audience: "nomo-inbound-proxy",
      upstreamId: "other-upstream",
    }),
    null,
  );
  assert.equal(issuer.authenticate("malformed", {
    audience: "nomo-inbound-proxy",
    upstreamId: "fixture-mcp",
  }), null);
});

test("revoking a run invalidates its capability", () => {
  const issuer = new LocalAgentIdentityIssuer({ now: () => 5000, wallNow: () => 5000 });
  const grant = issuer.issue({ ...binding, runId: "run-to-revoke" });
  assert.notEqual(issuer.validate(grant.token, request), null);
  assert.equal(issuer.revoke("run-to-revoke"), true);
  assert.equal(issuer.validate(grant.token, request), null);
  assert.equal(issuer.revoke("run-to-revoke"), false);
});

test("revoking an agent drops all its runs and blocks re-issue, other agents survive", () => {
  const issuer = new LocalAgentIdentityIssuer({ now: () => 5000, wallNow: () => 5000 });
  const first = issuer.issue({ ...binding, runId: "run-a1" });
  const second = issuer.issue({ ...binding, runId: "run-a2" });
  const other = issuer.issue({ ...binding, agentId: "other-agent", runId: "run-b1" });
  assert.equal(issuer.isAgentRevoked("registered-agent-1"), false);
  assert.equal(issuer.revokeAgent("registered-agent-1"), 2);
  assert.equal(issuer.isAgentRevoked("registered-agent-1"), true);
  assert.equal(issuer.isAgentRevoked("other-agent"), false);
  assert.equal(
    issuer.validate(first.token, request),
    null,
    "a revoked agent grant no longer authenticates",
  );
  assert.equal(issuer.validate(second.token, request), null);
  assert.notEqual(
    issuer.validate(other.token, request),
    null,
    "revocation is agent-scoped, not fleet-scoped",
  );
  assert.throws(
    () => issuer.issue({ ...binding, runId: "run-a3" }),
    /revoked/i,
    "a revoked agent cannot receive a new grant",
  );
  assert.notEqual(
    issuer.issue({ ...binding, agentId: "other-agent", runId: "run-b2" }).token.length,
    0,
    "an agent that was never revoked still issues",
  );
});

test("reissuing a run invalidates the previous grant and narrows scope", () => {
  const issuer = new LocalAgentIdentityIssuer({ now: () => 5000, wallNow: () => 5000 });
  const first = issuer.issue({ ...binding, runId: "same-run" });
  const second = issuer.issue({
    ...binding,
    runId: "same-run",
    toolScope: ["read"],
  });
  assert.equal(issuer.validate(first.token, request), null);
  assert.deepEqual(issuer.validate(second.token, request)?.toolScope, ["read"]);
  assert.equal(
    issuer.validate(second.token, { ...request, toolName: "write" }),
    null,
  );
});

test("a backwards clock fails closed", () => {
  let now = 5000;
  const issuer = new LocalAgentIdentityIssuer({ now: () => now, wallNow: () => now });
  const grant = issuer.issue(binding);
  now = 4999;
  assert.equal(issuer.validate(grant.token, request), null);
});

test("the monotonic deadline expires grants when wall time stalls", () => {
  let monotonic = 5000;
  const issuer = new LocalAgentIdentityIssuer({
    now: () => monotonic,
    wallNow: () => 1000,
  });
  const grant = issuer.issue(binding);
  monotonic += 60_000;
  assert.equal(issuer.validate(grant.token, request), null);
});

async function identityCatalogServer() {
  const server: Server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || "{}");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "tools/list" ? { tools: [{ name: "read" }] } : {},
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("Workbench issues grants from stored active session identity and revokes at run end", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-agent-identity-"));
  const target = await identityCatalogServer();
  const gateCommand = join(directory, "before-run-gate.mjs");
  await writeFile(
    gateCommand,
    `#!${process.execPath}\nawait new Promise((resolve) => setTimeout(resolve, 750));\n`,
    { mode: 0o700 },
  );
  let releaseCompletion: (response: Response) => void = () => {};
  const completion = new Promise<Response>((resolve) => {
    releaseCompletion = resolve;
  });
  const fetcher: typeof fetch = async (input) =>
    String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : completion;
  const app = new Workbench(
    {
      VOID_DATA_DIR: directory,
      VOID_HOOK_COMMANDS: JSON.stringify([gateCommand]),
    },
    fetcher,
  );
  t.after(async () => {
    releaseCompletion(
      Response.json({ choices: [{ message: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] }),
    );
    await app.shutdown();
    await target.close();
    await rm(directory, { recursive: true, force: true });
  });

  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  await app.addConnector({ url: target.url, name: "Fixture MCP" });
  const connectorId = app.connectionState().connectors.at(-1)!.id;
  await app.probeConnector(connectorId);
  await app.confirmConnector(connectorId);
  app.upsertHook({
    id: "before-run-gate",
    event: "before-run",
    command: gateCommand,
    enabled: true,
  });
  const session = await app.start(
    "use the fixture tool",
    "fixture",
    undefined,
    "caller-project-metadata",
  );
  assert.throws(
    () => app.issueLocalAgentGrant(session.id, connectorId),
    /before-run|ready/i,
  );
  // The hook runs in a real child process; wait for its session event, not a guessed delay.
  const hookDeadline = Date.now() + 10_000;
  let hookResult: { outcome?: string; code?: number } | undefined;
  while (!hookResult && Date.now() < hookDeadline) {
    const hookEvent = app
      .get(session.id)
      ?.events.find((event) => event.type === "hook.result");
    hookResult = hookEvent?.payload?.hook as typeof hookResult;
    if (!hookResult) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    hookResult?.outcome,
    "exited",
    JSON.stringify(app.get(session.id)?.events),
  );
  assert.equal(app.get(session.id)?.status, "running");

  const grant = app.issueLocalAgentGrant(session.id, connectorId);
  const resolved = app.resolveLocalAgentGrant(grant.token, connectorId);
  assert.ok(resolved);
  assert.deepEqual(resolved.toolScope, ["read"]);
  assert.equal(app.resolveLocalAgentGrant(grant.token, "other-upstream"), null);
  assert.ok(grant.expiresAt > Date.now());
  assert.ok(grant.expiresAt <= Date.now() + 60_000);
  const forgedRequest = {
    ...request,
    upstreamId: connectorId,
    toolName: "read",
    principalId: "caller-principal",
    workspaceId: "caller-workspace",
    agentId: "caller-agent",
    runId: "caller-run",
  };
  const verified = app.validateLocalAgentGrant(
    grant.token,
    forgedRequest,
  );
  assert.ok(verified);
  assert.equal(verified.principalId, "workbench-local");
  assert.equal(verified.workspaceId, session.workspace);
  assert.equal(verified.agentId, session.agent);
  assert.equal(verified.runId, session.runId);
  assert.notEqual(verified.workspaceId, session.project);
  assert.notEqual(verified.agentId, "caller-agent");
  assert.notEqual(verified.runId, "caller-run");
  assert.equal(verified.upstreamId, connectorId);
  assert.deepEqual(verified.toolScope, ["read"]);
  assert.equal(
    app.validateLocalAgentGrant(grant.token, {
      ...request,
      upstreamId: "unconfigured-upstream",
    }),
    null,
  );
  assert.throws(
    () => app.issueLocalAgentGrant!("caller-session", connectorId),
    /session/i,
  );
  assert.throws(
    () => app.issueLocalAgentGrant!(session.id, "unconfigured-upstream"),
    /upstream|tool/i,
  );

  releaseCompletion(
    Response.json({ choices: [{ message: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] }),
  );
  await app.settled();
  assert.equal(
    app.validateLocalAgentGrant(grant.token, request),
    null,
  );
  assert.throws(
    () => app.issueLocalAgentGrant!(session.id, connectorId),
    /active run/i,
  );
});

test("revoking an agent stops its sessions, signs evidence and blocks new starts", async (t) => {
  const fetcher: typeof fetch = async (input) =>
    String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({
          choices: [
            { message: { role: "assistant", content: "done" }, finish_reason: "stop" },
          ],
        });
  const { app } = await isolatedWorkbench(t, fetcher);
  const session = await app.start("do something", "fixture");
  const agentId = session.agent;
  assert.ok(agentId, "the session carries an agent identity");
  assert.equal(app.isAgentRevoked(agentId), false);

  const result = await app.revokeAgent(agentId, "test-operator");
  assert.equal(app.isAgentRevoked(agentId), true);
  await assert.rejects(
    app.start("another run", "fixture"),
    /revoked/,
    "a revoked agent cannot start a new session",
  );
  await app.settled();
  const proof = await app.ledger(session.workspace);
  const record = proof?.entries
    .map((entry) => entry.body as Record<string, unknown>)
    .find((body) => body.tool === "agent_revoke");
  assert.ok(record, "the revocation writes a signed chain record");
  assert.equal(record.approvedBy, "test-operator");
  assert.equal(record.revokedAgentId, agentId);
  assert.ok(result, "revokeAgent reports what it did");
});

test("a revoked agent stays revoked across a restart", async (t) => {
  const fetcher: typeof fetch = async (input) =>
    String(input).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({
          choices: [
            { message: { role: "assistant", content: "done" }, finish_reason: "stop" },
          ],
        });
  const fixture = await isolatedWorkbench(t, fetcher, {}, {
    prefix: "nomo-agent-revoke-restart-",
  });
  const session = await fixture.app.start("do something", "fixture");
  const agentId = session.agent;
  assert.ok(agentId, "the session carries an agent identity");
  await fixture.app.revokeAgent(agentId, "test-operator");
  assert.equal(fixture.app.isAgentRevoked(agentId), true);

  const reopened = fixture.restart();
  assert.equal(
    reopened.isAgentRevoked(agentId),
    true,
    "the revocation restores from signed evidence, not process state",
  );
  await assert.rejects(
    reopened.start("another run", "fixture"),
    /revoked/,
    "a revoked agent cannot start after a restart either",
  );
});

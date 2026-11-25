import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { Workbench } from "./index.ts";
import { LocalStorage } from "./storage.ts";
import { loadPolicy } from "../../policy/src/rules.ts";
import { policyDigest } from "../../policy/src/digest.ts";
import { mineLearnedRules } from "./learned-rules.ts";
import { entryHash, GENESIS_PREV } from "../../ledger/src/canonical.ts";
import { signingPreimage } from "../../ledger/src/index.ts";
import { devKeyProvider, sha256Hex } from "../../ledger/src/sign.ts";
import type { JsonlEntry } from "../../ledger/src/index.ts";

/** A minimal MCP server over loopback HTTP that answers the catalog handshake
 * and counts the requests it received, so a test can prove that a staged
 * connector sent nothing. */
async function catalogServer(
  tools: { name: string; description?: string }[],
  status = 200,
) {
  const methods: string[] = [];
  // The method names prove whether a call left the workbench; the bodies let
  // a test pin which tool was asked for without a second server per tool.
  const bodies: unknown[] = [];
  const server: Server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    if (body.method) methods.push(body.method);
    bodies.push(body);
    if (status !== 200) {
      res.statusCode = status;
      res.end("Service Unavailable");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: body.method === "tools/list" ? { tools } : {},
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    methods,
    bodies,
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const provider = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] });

function connectorState(app: Workbench, id: string) {
  const found = app.connectionState().connectors.find((item) => item.id === id);
  assert.ok(found, "connector is listed");
  return found;
}

test("a connector is inert until the operator probes and confirms it", async (t) => {
  const server = await catalogServer([{ name: "test-tool" }]);
  t.after(() => server.close());
  // `configure` defaults to the same base URL and API key this test used.
  const { app } = await isolatedWorkbench(t, provider, {}, { prefix: "nomo-consent-" });

  await app.addConnector({ url: server.url, name: "Test" });
  const id = app.connectionState().connectors.at(-1)!.id;
  assert.equal(server.methods.length, 0, "adding a connector sends no request");
  assert.equal(connectorState(app, id).consentState, "staged");
  assert.deepEqual(connectorState(app, id).tools, []);

  await app.updateConnector(id, { name: "Renamed" });
  assert.equal(server.methods.length, 0, "editing a connector sends no request");
  assert.equal(connectorState(app, id).consentState, "staged");
  assert.deepEqual(connectorState(app, id).tools, []);

  assert.ok(
    !app.availableTools().tools.some((tool) => tool.name === "test-tool"),
    "a staged connector offers no tools",
  );

  await app.probeConnector(id);
  assert.ok(server.methods.includes("tools/list"), "probing contacts the server");
  const clientNames = server.bodies.map(
    (body) =>
      (body as {
        params?: {
          _meta?: {
            "io.modelcontextprotocol/clientInfo"?: { name?: string };
          };
        };
      }).params?._meta?.["io.modelcontextprotocol/clientInfo"]?.name,
  );
  assert.deepEqual(
    [...new Set(clientNames)],
    ["nomo-cloud"],
    "every MCP request identifies NOMO as the client",
  );
  assert.equal(connectorState(app, id).consentState, "probed");
  assert.deepEqual(connectorState(app, id).tools, ["test-tool"]);
  assert.ok(
    !app.availableTools().tools.some((tool) => tool.name === "test-tool"),
    "a probed but unconfirmed connector offers no tools",
  );

  await app.confirmConnector(id);
  assert.equal(connectorState(app, id).consentState, "confirmed");
  assert.ok(
    app.availableTools().tools.some((tool) => tool.name === "test-tool"),
    "a confirmed connector offers its tools",
  );
  const session = await app.start("hello", "fixture");
  assert.ok(
    app.availableTools(session.id).tools.some((tool) => tool.name === "test-tool"),
    "a new conversation loads the confirmed catalog",
  );
});

test("a failed probe keeps consent and catalog empty while recording error", async (t) => {
  const server = await catalogServer([], 503);
  t.after(() => server.close());
  const f = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "nomo-probe-fail-" });
  const app = f.app;
  await app.addConnector({ url: server.url, name: "Failing" });
  const id = app.connectionState().connectors.at(-1)!.id;

  await assert.rejects(app.probeConnector(id), /HTTP 503/);
  assert.equal(connectorState(app, id).consentState, "staged");
  assert.deepEqual(connectorState(app, id).tools, []);
  const failed = connectorState(app, id);
  assert.equal(
    "lastProbeOutcome" in failed ? failed.lastProbeOutcome : undefined,
    "error",
  );
  await app.shutdown();

  const reopened = f.restart({ keepOpen: true });
  assert.equal(connectorState(reopened, id).consentState, "staged");
  assert.deepEqual(connectorState(reopened, id).tools, []);
  const persisted = connectorState(reopened, id);
  assert.equal(
    "lastProbeOutcome" in persisted ? persisted.lastProbeOutcome : undefined,
    "error",
  );
});

test("a snapshot written before the consent gate loads as staged with no catalog", async (t) => {
  const server = await catalogServer([{ name: "legacy-tool" }]);
  t.after(() => server.close());
  const f = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "nomo-legacy-" });
  const app = f.app;
  await app.addConnector({ url: server.url, name: "Legacy" });
  const id = app.connectionState().connectors.at(-1)!.id;
  await app.probeConnector(id);
  await app.confirmConnector(id);
  await app.shutdown();

  // Rewrite the persisted snapshot the way a build without the gate wrote it.
  const key = await readFile(join(f.root, "workspace.key"));
  const path = join(f.root, "workspace.enc");
  const stored = await readFile(path);
  const decipher = createDecipheriv("aes-256-gcm", key, stored.subarray(0, 12));
  decipher.setAuthTag(stored.subarray(12, 28));
  const snapshot = JSON.parse(
    Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]).toString(),
  );
  for (const connector of snapshot.connectors) delete connector.consentState;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(snapshot)),
    cipher.final(),
  ]);
  await writeFile(path, Buffer.concat([iv, cipher.getAuthTag(), bytes]));

  const reopened = f.restart({ keepOpen: true });
  assert.equal(connectorState(reopened, id).consentState, "staged");
  assert.deepEqual(connectorState(reopened, id).tools, []);
});

test("a connector token never appears in the public state", async (t) => {
  const { app } = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "nomo-redact-" });
  await app.addConnector({
    url: "https://mcp.example.com/mcp",
    token: "super-secret-token-12345",
    name: "Secret",
  });
  assert.doesNotMatch(JSON.stringify(app.connectionState()), /super-secret-token-12345/);
});

test("runtime connector grants authenticate each request and expire across restart", async (t) => {
  const grant = "runtime-only-grant";
  const methods: string[] = [];
  const authorizations: string[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text || "{}");
    methods.push(body.method);
    authorizations.push(request.headers.authorization ?? "");
    if (request.headers.authorization !== `Bearer ${grant}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "runtime-tool",
                    description: "runtime-tool: fixture",
                    inputSchema: { type: "object" },
                  },
                ],
              }
            : { content: [{ type: "text", text: "fixture result" }] },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(
    () =>
      new Promise<void>((resolve) =>
        server.close(() => resolve()),
      ),
  );

  let grantsIssued = 0;
  const gate = { wantCall: true };
  const fixture = await isolatedWorkbench(
    t,
    phasedProvider((tools) => {
      const selected = tools.find((tool) =>
        String(tool.function.description ?? "").startsWith("runtime-tool:"),
      );
      assert.ok(selected, "the confirmed connector tool reaches the model");
      return selected.function.name;
    }, gate) as typeof fetch,
    {},
    { prefix: "nomo-runtime-grant-" },
  );
  const { app } = fixture;
  await app.addConnector({
    url: `http://127.0.0.1:${address.port}/mcp`,
    name: "Runtime proxy",
    connectionless: true,
    tokenProvider: () => {
      grantsIssued += 1;
      return grant;
    },
    mapping: { "runtime-tool": DELETE },
    facts: connectorFacts,
    policy: allowAll,
  });
  const connectorId = app.connectionState().connectors.at(-1)!.id;
  await app.probeConnector(connectorId);
  await app.confirmConnector(connectorId);
  const session = await app.start("Call the runtime fixture tool", "fixture");
  await app.settled();

  assert.ok(methods.includes("tools/call"), "the model call reaches the connector");
  assert.equal(grantsIssued, methods.length, "a fresh grant is requested per MCP call");
  assert.ok(
    authorizations.every((authorization) => authorization === `Bearer ${grant}`),
    "each MCP request carries the runtime grant",
  );
  assert.equal(gate.wantCall, false);
  assert.doesNotMatch(
    JSON.stringify(app.connectionState()),
    /runtime-only-grant/,
    "public connector state never contains the grant",
  );

  const internals = app as unknown as { storage: { directory: string } };
  const saved = new LocalStorage(internals.storage.directory).read<{
    connectors: Record<string, unknown>[];
    sessions: {
      tools: { connectorId?: string }[];
      connections: Record<string, Record<string, unknown>>;
    }[];
  }>();
  assert.ok(saved);
  assert.equal(saved.connectors[0]!.tokenProvider, undefined);
  assert.equal(saved.connectors[0]!.runtimeTokenProviderRequired, true);
  assert.equal(saved.sessions.at(-1)!.connections[connectorId]!.tokenProvider, undefined);
  assert.equal(
    saved.sessions.at(-1)!.connections[connectorId]!.runtimeTokenProviderRequired,
    true,
  );

  assert.equal(app.get(session.id)?.status, "idle");
  const reopened = fixture.restart();
  assert.equal(
    connectorState(reopened, connectorId).consentState,
    "staged",
    "a connector whose runtime grant provider vanished cannot retain consent",
  );
  assert.deepEqual(connectorState(reopened, connectorId).tools, []);
  const restored = (reopened as unknown as {
    sessions: Map<string, {
      tools: { connectorId?: string }[];
      connections: Record<string, { consentState: string; tools: unknown[] }>;
    }>;
  }).sessions.get(session.id)!;
  assert.equal(restored.connections[connectorId]!.consentState, "staged");
  assert.deepEqual(restored.connections[connectorId]!.tools, []);
  assert.equal(
    restored.tools.some((tool) => tool.connectorId === connectorId),
    false,
    "a restored session cannot retain a catalog from a vanished runtime provider",
  );
  assert.equal(gate.wantCall, false);

});

test("twelve connectors is the limit", async (t) => {
  const { app } = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "nomo-limit-" });
  for (let index = 0; index < 12; index += 1)
    await app.addConnector({ url: `https://mcp-${index}.example.com/mcp` });
  await assert.rejects(
    app.addConnector({ url: "https://mcp-overflow.example.com/mcp" }),
    /Connector limit reached/,
  );
});

test("a non-loopback HTTP endpoint and embedded credentials are refused", async (t) => {
  const { app } = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "nomo-validation-" });
  for (const url of [
    "http://example.com/mcp",
    "https://example.com/mcp?token=abc",
    "https://user:secret@example.com/mcp",
  ])
    await assert.rejects(app.addConnector({ url }), /endpoint/i);
  await app.addConnector({ url: "http://127.0.0.1:8080/mcp" });
});

test("the policy preview shows the decision each tool would get", async (t) => {
  const server = await catalogServer([
    { name: "unmapped_unknown_thing" },
    { name: "delete" },
  ]);
  t.after(() => server.close());
  const { app } = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "nomo-preview-" });
  await app.addConnector({
    url: server.url,
    name: "Preview",
    mapping: { delete: "aws.s3.object.delete" },
    facts: { "bucket.versioning": "Enabled" },
  });
  const id = app.connectionState().connectors.at(-1)!.id;
  await app.probeConnector(id);

  const preview = app.policyPreview(id);
  assert.equal(preview.consentState, "probed");
  assert.equal(server.methods.filter((method) => method === "tools/list").length, 1);
  const unknown = preview.tools.find((tool) => tool.tool === "unmapped_unknown_thing")!;
  assert.equal(unknown.decision, "deny");
  assert.match(unknown.classification, /No registry entry/);
  const mapped = preview.tools.find((tool) => tool.tool === "delete")!;
  assert.equal(mapped.mapped, "aws.s3.object.delete");
  assert.equal(mapped.decision, "hold");
  assert.equal(mapped.blastRadius, "unknown");
  assert.equal(preview.counts.deny, 1);
  assert.equal(preview.counts.hold, 1);
});

const DELETE_TOOL = { name: "delete", description: "delete: fixture" };
const DELETE = "aws.s3.object.delete";
const connectorFacts = { "bucket.versioning": "Enabled" };
const allowAll =
  "version: 1\nrules:\n  - match: {}\n    decision: allow\n";

/** Stage a connector, then make it usable, without ever letting the test forget
 * that both steps are separate operator actions. */
async function confirmedConnector(
  app: Workbench,
  url: string,
  name: string,
  policy: string,
  mapping: Record<string, string>,
  facts: Record<string, string>,
) {
  await app.addConnector({ url, name, mapping, facts, policy });
  const id = app.connectionState().connectors.at(-1)!.id;
  await app.probeConnector(id);
  await app.confirmConnector(id);
  return id;
}

/** A provider that answers one tool call per user turn while the test allows
 * it, then closes. The gate starts closed in tests that must seed evidence
 * before the call is decided: a provider that calls on its first turn would
 * race that seeding, and the test would prove timing rather than policy. */
function phasedProvider(
  pick: (tools: { function: { name: string; description?: string } }[]) => string,
  gate: { wantCall: boolean },
) {
  return async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const messages = (body.messages ?? []) as { role: string }[];
    if (messages.some((message) => message.role === "tool"))
      return Response.json({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
    // The learned-entry digest rides after the user message as a system
    // message, so the last message is not always the one to answer.
    const last = [...messages]
      .reverse()
      .find((message) => message.role !== "system");
    if (last?.role === "user" && gate.wantCall) {
      gate.wantCall = false;
      return Response.json({ choices: [{ message: { role: "assistant",
      content: null, tool_calls: [
        {
          id: "one",
          type: "function",
          function: { name: pick(body.tools ?? []), arguments: "{}" },
        },
      ] }, finish_reason: "tool_calls" }] });
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "ready" }, finish_reason: "stop" }] });
  };
}

const deleteName = (tools: { function: { name: string; description?: string } }[]) =>
  tools.find((tool) => String(tool.function.description ?? "").startsWith("delete:"))!
    .function.name;

const unmappedName = (tools: { function: { name: string; description?: string } }[]) =>
  tools.find((tool) => String(tool.function.description ?? "").startsWith("unmapped_unknown_thing:"))!
    .function.name;

type SeededEvidence = {
  evidence: Record<string, { body: unknown }[]>;
};

function refusalSeed(tool: string, klass: string) {
  return [
    { body: { tool, klass, decision: "deny:policy" } },
    { body: { tool, klass, decision: "deny:policy" } },
    { body: { tool, klass, decision: "hold:denied" } },
  ];
}

/**
 * The same refusals, signed into the workspace chain.
 *
 * A seed that is only a body teaches the miner and nothing else: the chain
 * reader verifies every entry, so an unsigned seed turns any path that reads
 * the chain into a signature failure. The records are built the way the
 * workbench builds them, with the workbench's own key.
 */
async function signRefusals(
  app: unknown,
  workspace: string,
  bodies: readonly { body: Record<string, unknown> }[],
) {
  const internals = app as unknown as {
    evidence: Record<string, JsonlEntry[]>;
    storage: { directory: string };
    env: Record<string, string | undefined>;
  };
  const key = await devKeyProvider({
    dir: join(internals.storage.directory, "keys"),
    env: internals.env,
  });
  const keyId = await key.currentKeyId();
  const current = internals.evidence[workspace] ?? [];
  for (const seed of bodies) {
    // The verifier binds a record to its workspace through the signed body,
    // so a seed that leaves it out is rejected at the first entry.
    const body = { workspace, ...seed.body };
    const prev = current.at(-1)?.hash ?? GENESIS_PREV;
    const hash = await entryHash(body, prev, sha256Hex);
    current.push({
      workspace,
      seq: current.length + 1,
      body,
      prev_hash: prev,
      hash,
      key_id: keyId,
      alg: key.alg,
      signature: `${key.alg}:${Buffer.from(
        await key.sign(signingPreimage(key.alg, keyId, hash)),
      ).toString("base64")}`,
    } as JsonlEntry);
  }
  internals.evidence[workspace] = current;
  return current;
}

test("workspace-mined refusal never holds a connector call", async (t) => {
  const server = await catalogServer([DELETE_TOOL]);
  t.after(() => server.close());
  const gate = { wantCall: false };
  const { app } = await isolatedWorkbench(t, phasedProvider(deleteName, gate), {}, {
    prefix: "nomo-learned-connector-",
  });
  const id = await confirmedConnector(
    app,
    server.url,
    "Fixture",
    allowAll,
    { delete: DELETE },
    connectorFacts,
  );
  const listed = app
    .policyPreview(id)
    .tools.find((tool) => tool.tool === "delete");
  assert.equal(
    listed?.klass,
    "r3",
    "the fixture delete classifies r3, which is the class the seed below refuses",
  );

  const session = await app.start("hello", "fixture");
  await app.settled();
  assert.equal(app.get(session.id)?.status, "idle");

  // Three refusals of the mapped tool under its classified class: exactly what
  // mines a hold rule for this call shape. The miner call proves the seed
  // would bind if it were consulted, so the passing call below is a statement
  // about the connector path rather than about a seed that teaches nothing.
  const seed = refusalSeed(DELETE, "r3");
  assert.equal(
    mineLearnedRules(seed).length,
    1,
    "the seed mines the hold rule this test claims is ignored",
  );
  const internals = app as unknown as SeededEvidence;
  await signRefusals(app, session.workspace, seed);
  const before = (internals.evidence[session.workspace] ?? []).length;

  gate.wantCall = true;
  app.send(session.id, "Delete it");
  await app.settled();

  assert.equal(app.get(session.id)?.status, "idle");
  assert.ok(
    server.methods.includes("tools/call"),
    "the connector ran the call upstream",
  );
  const added = (internals.evidence[session.workspace] ?? [])
    .slice(before)
    .map((entry) => entry.body as Record<string, unknown>);
  assert.ok(
    added.some((body) => body.tool === DELETE && body.decision === "allow"),
    "the operator policy allowed the call",
  );
  assert.ok(
    !added.some(
      (body) =>
        body.tool === DELETE &&
        typeof body.decision === "string" &&
        body.decision.startsWith("hold"),
    ),
    "no learned hold touched the call",
  );
});

test("connector attribution names the raw operator policy digest", async (t) => {
  const server = await catalogServer([DELETE_TOOL]);
  t.after(() => server.close());
  const { app } = await isolatedWorkbench(
    t,
    phasedProvider(deleteName, { wantCall: true }),
    {},
    { prefix: "nomo-connector-attribution-" },
  );
  await confirmedConnector(app, server.url, "Fixture", allowAll, { delete: DELETE }, connectorFacts);

  const session = await app.start("Delete it", "fixture");
  await app.settled();
  assert.equal(app.get(session.id)?.status, "idle");
  assert.ok(
    server.methods.includes("tools/call"),
    "the connector ran the call upstream",
  );

  const loaded = loadPolicy(allowAll);
  if (!loaded.ok)
    throw new Error(`fixture policy failed to load: ${loaded.errors.join("; ")}`);
  const internals = app as unknown as SeededEvidence;
  const record = (internals.evidence[session.workspace] ?? [])
    .map((entry) => entry.body as Record<string, unknown>)
    .find((body) => body.tool === DELETE && body.decision === "allow");
  assert.ok(record, "the allow decision was recorded");
  const attribution = record.attribution as
    | { policyDigest: string; rule?: { index: number } }
    | undefined;
  assert.equal(
    attribution?.policyDigest,
    policyDigest(loaded.policy),
    "the record names the raw operator policy, not a merged one",
  );
  assert.equal(
    attribution?.rule?.index,
    0,
    "the operator catch-all decided, at its own index",
  );
});

test("a canonical registry name resolves to one explicitly mapped connector tool", async (t) => {
  const server = await catalogServer([DELETE_TOOL]);
  t.after(() => server.close());
  const gate = { wantCall: true };
  const { app } = await isolatedWorkbench(
    t,
    phasedProvider(() => DELETE, gate),
    {},
    { prefix: "nomo-connector-canonical-alias-" },
  );
  await confirmedConnector(
    app,
    server.url,
    "Fixture",
    allowAll,
    { delete: DELETE },
    connectorFacts,
  );

  const session = await app.start("Delete it", "fixture");
  await app.settled();

  assert.ok(
    server.methods.includes("tools/call"),
    "the uniquely mapped canonical name dispatches the advertised tool",
  );
});

test("an ambiguous canonical name never dispatches a connector tool", async (t) => {
  const server = await catalogServer([
    DELETE_TOOL,
    { name: "remove", description: "remove: fixture" },
  ]);
  t.after(() => server.close());
  const { app } = await isolatedWorkbench(
    t,
    phasedProvider(() => DELETE, { wantCall: true }),
    {},
    { prefix: "nomo-connector-ambiguous-alias-" },
  );
  await confirmedConnector(
    app,
    server.url,
    "Fixture",
    allowAll,
    { delete: DELETE, remove: DELETE },
    connectorFacts,
  );

  await app.start("Delete it", "fixture");
  await app.settled();

  assert.equal(
    server.methods.includes("tools/call"),
    false,
    "ambiguous canonical names fail closed before upstream dispatch",
  );
});

test("unclassified tool fails closed on the connector path", async (t) => {
  const server = await catalogServer([
    { name: "unmapped_unknown_thing", description: "unmapped_unknown_thing: fixture" },
  ]);
  t.after(() => server.close());
  const gate = { wantCall: false };
  const { app } = await isolatedWorkbench(
    t,
    phasedProvider(unmappedName, gate),
    {},
    { prefix: "nomo-unclassified-" },
  );
  await confirmedConnector(app, server.url, "Fixture", allowAll, {}, connectorFacts);
  const internals = app as unknown as SeededEvidence;
  const calls = () =>
    server.methods.filter((method) => method === "tools/call").length;
  const refusals = (workspace: string, from: number) =>
    (internals.evidence[workspace] ?? [])
      .slice(from)
      .map((entry) => entry.body as Record<string, unknown>);

  // With seeded learned rules for the same shape: the refusal must look
  // exactly like the operator policy refusing, because classification fails
  // before any policy, merged or raw, is consulted.
  const seeded = await app.start("hello", "fixture");
  await app.settled();
  await signRefusals(app, seeded.workspace, refusalSeed("unmapped_unknown_thing", "r3"));
  const seededFrom = (internals.evidence[seeded.workspace] ?? []).length;
  const callsBeforeSeeded = calls();
  gate.wantCall = true;
  app.send(seeded.id, "Call the unknown tool");
  await app.settled();
  assert.equal(app.get(seeded.id)?.status, "idle", "a refusal is an answer, not a crash");
  assert.equal(calls(), callsBeforeSeeded, "the upstream never saw the call");
  const seededBodies = refusals(seeded.workspace, seededFrom);
  assert.ok(
    seededBodies.some(
      (body) => body.tool === "unmapped_unknown_thing" && body.decision === "deny",
    ),
    "the unclassified call was denied",
  );

  // Without any seeded rules: the same refusal, proving learned rules change
  // nothing on this path in either direction.
  gate.wantCall = true;
  const plain = await app.start("Call the unknown tool", "fixture");
  await app.settled();
  assert.equal(app.get(plain.id)?.status, "idle", "a refusal is an answer, not a crash");
  assert.equal(calls(), callsBeforeSeeded, "the upstream never saw the call");
  const plainBodies = refusals(plain.workspace, 0);
  assert.ok(
    plainBodies.some(
      (body) => body.tool === "unmapped_unknown_thing" && body.decision === "deny",
    ),
    "the unclassified call was denied",
  );
});

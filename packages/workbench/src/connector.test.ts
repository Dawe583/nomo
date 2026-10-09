import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isolatedWorkbench } from "./test-fixture.ts";
import type { Workbench } from "./index.ts";

/** A minimal MCP server over loopback HTTP that answers the catalog handshake
 * and counts the requests it received, so a test can prove that a staged
 * connector sent nothing. */
async function catalogServer(tools: { name: string }[], status = 200) {
  const methods: string[] = [];
  const server: Server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    if (body.method) methods.push(body.method);
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
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const provider = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "Ready" } }] });

function connectorState(app: Workbench, id: string) {
  const found = app.connectionState().connectors.find((item) => item.id === id);
  assert.ok(found, "connector is listed");
  return found;
}

test("a connector is inert until the operator probes and confirms it", async (t) => {
  const server = await catalogServer([{ name: "test-tool" }]);
  t.after(() => server.close());
  // `configure` defaults to the same base URL and API key this test used.
  const { app } = await isolatedWorkbench(t, provider, {}, { prefix: "void-consent-" });

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

test("a failed probe leaves the staged connector exactly as it was", async (t) => {
  const server = await catalogServer([], 503);
  t.after(() => server.close());
  const f = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "void-probe-fail-" });
  const app = f.app;
  await app.addConnector({ url: server.url, name: "Failing" });
  const id = app.connectionState().connectors.at(-1)!.id;

  await assert.rejects(app.probeConnector(id), /HTTP 503/);
  assert.equal(connectorState(app, id).consentState, "staged");
  assert.deepEqual(connectorState(app, id).tools, []);
  await app.shutdown();

  const reopened = f.restart({ keepOpen: true });
  assert.equal(connectorState(reopened, id).consentState, "staged");
  assert.deepEqual(connectorState(reopened, id).tools, []);
});

test("a snapshot written before the consent gate loads as staged with no catalog", async (t) => {
  const server = await catalogServer([{ name: "legacy-tool" }]);
  t.after(() => server.close());
  const f = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "void-legacy-" });
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
  const { app } = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "void-redact-" });
  await app.addConnector({
    url: "https://mcp.example.com/mcp",
    token: "super-secret-token-12345",
    name: "Secret",
  });
  assert.doesNotMatch(JSON.stringify(app.connectionState()), /super-secret-token-12345/);
});

test("twelve connectors is the limit", async (t) => {
  const { app } = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "void-limit-" });
  for (let index = 0; index < 12; index += 1)
    await app.addConnector({ url: `https://mcp-${index}.example.com/mcp` });
  await assert.rejects(
    app.addConnector({ url: "https://mcp-overflow.example.com/mcp" }),
    /Connector limit reached/,
  );
});

test("a non-loopback HTTP endpoint and embedded credentials are refused", async (t) => {
  const { app } = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "void-validation-" });
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
  const { app } = await isolatedWorkbench(t, undefined, {}, { configure: false, prefix: "void-preview-" });
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

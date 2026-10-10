import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { Workbench } from "./index.ts";

/** An MCP server that answers the catalog handshake and records every method
 * it was asked for, so a test can prove a call never left NOMO. */
async function mcpServer(tools: { name: string; description: string }[]) {
  const methods: string[] = [];
  const server: Server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    if (body.method) methods.push(body.method);
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

/** A provider that answers its first turn with one tool call, chosen by the
 * test from the catalogue the conversation was offered, then closes. */
function callingProvider(pick: (tools: { function: { name: string; description: string } }[]) => string) {
  return async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const messages = (body.messages ?? []) as { role: string }[];
    if (messages.some((message) => message.role === "tool"))
      return Response.json({ choices: [{ message: { role: "assistant", content: "done" } }] });
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "one",
                type: "function",
                function: { name: pick(body.tools ?? []), arguments: "{}" },
              },
            ],
          },
        },
      ],
    });
  };
}

const DELETE_TOOL = { name: "delete", description: "delete: fixture" };
const DELETE = "aws.s3.object.delete";
const facts = { "bucket.versioning": "Enabled" };
const denyDeletes =
  "version: 1\nrules:\n  - match:\n      tool: aws.s3.object.delete\n    decision: deny\n    rationale: deletes are refused by this fixture\n  - match: {}\n    decision: allow\n";
const allowAll = "version: 1\nrules:\n  - match: {}\n    decision: allow\n";

/** Stage a connector, then make it usable, without ever letting the test forget
 * that both steps are separate operator actions. */
async function confirmedConnector(app: Workbench, url: string, name: string, policy: string) {
  await app.addConnector({ url, name, mapping: { delete: DELETE }, facts, policy });
  const id = app.connectionState().connectors.at(-1)!.id;
  await app.probeConnector(id);
  await app.confirmConnector(id);
  return id;
}

const deleteCall = (tools: { function: { name: string; description: string } }[]) =>
  tools.find((tool) => tool.function.description.startsWith("delete:"))!.function.name;

test("a tool the provider invented never reaches the connector", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-invented-"));
  const server = await mcpServer([DELETE_TOOL]);
  const app = new Workbench({ NOMO_DATA_DIR: directory }, callingProvider(() => "not_in_catalog"));
  t.after(async () => {
    await app.shutdown();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  await confirmedConnector(app, server.url, "Fixture", allowAll);

  const session = await app.start("Delete it", "fixture");
  await app.settled();
  assert.equal(app.get(session.id)?.status, "failed");
  assert.ok(
    !server.methods.includes("tools/call"),
    "the connector is never asked to run a tool NOMO does not know",
  );
  assert.ok(
    app
      .get(session.id)
      ?.events.some((event) => /outside the approved MCP catalog/.test(event.text)),
  );
});

test("a deny rule stops the call and the connector never sees it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-denied-"));
  const server = await mcpServer([DELETE_TOOL]);
  const app = new Workbench({ NOMO_DATA_DIR: directory }, callingProvider(deleteCall));
  t.after(async () => {
    await app.shutdown();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const id = await confirmedConnector(app, server.url, "Refused", denyDeletes);
  assert.equal(app.policyPreview(id).tools[0]?.classification, "always");

  const session = await app.start("Delete it", "fixture");
  await app.settled();
  assert.equal(app.get(session.id)?.status, "idle", "a denial is an answer, not a crash");
  assert.ok(
    app.get(session.id)?.events.some((event) => /refused or failed/.test(event.text)),
  );
  const ledger = await app.ledger(session.workspace);
  assert.ok(
    ledger?.entries.some((entry) => (entry.body as { decision: string }).decision === "deny"),
  );
  assert.equal(server.methods.includes("tools/call"), false);
});

test("the same classified tool runs when the operator policy allows it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-allowed-"));
  const server = await mcpServer([DELETE_TOOL]);
  const app = new Workbench({ NOMO_DATA_DIR: directory }, callingProvider(deleteCall));
  t.after(async () => {
    await app.shutdown();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const id = await confirmedConnector(app, server.url, "Allowed", allowAll);
  assert.equal(app.policyPreview(id).tools[0]?.decision, "allow");

  const session = await app.start("Delete it", "fixture");
  await app.settled();
  const ledger = await app.ledger(session.workspace);
  assert.ok(
    ledger?.entries.some((entry) => (entry.body as { decision: string }).decision === "allow"),
  );
  assert.equal(server.methods.filter((method) => method === "tools/call").length, 1);
});

test("a running conversation keeps the policy it started with", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-frozen-policy-"));
  const server = await mcpServer([DELETE_TOOL]);
  const app = new Workbench({ NOMO_DATA_DIR: directory }, callingProvider(deleteCall));
  t.after(async () => {
    await app.shutdown();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const id = await confirmedConnector(app, server.url, "Fixture", allowAll);
  const session = await app.start("Delete it", "fixture");

  await app.updateConnector(id, { policy: denyDeletes });
  await app.settled();

  const ledger = await app.ledger(session.workspace);
  assert.ok(
    ledger?.entries.some((entry) => (entry.body as { decision: string }).decision === "allow"),
    "the conversation is judged by the policy it started with, not the edited one",
  );
  assert.equal(server.methods.filter((method) => method === "tools/call").length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { WorkspaceTui, renderWorkspace } from "./workspace.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

const SECRET = "connector-token-9f2c";
const assistant = async (url: unknown) => {
  if (String(url).endsWith("/models"))
    return Response.json({ data: [{ id: "fixture" }] });
  return Response.json({
    choices: [{ message: { role: "assistant", content: "ok" } }],
  });
};

/** A local MCP server that records every JSON-RPC method it is sent, so a test
 * can prove that staging and declining both contact nothing. `refuse()` turns
 * the next exchange into the refusal a bad server would produce. */
async function upstream(t: { after: (fn: () => unknown) => void }) {
  const hits: string[] = [];
  let refuse = false;
  const listener = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    hits.push(body.method);
    if (refuse) {
      res.statusCode = 500;
      res.end("no catalog here");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "fixture_send",
                    description: "Local counter only, nothing is sent.",
                    inputSchema: {
                      type: "object",
                      properties: { text: { type: "string" } },
                    },
                  },
                ],
              }
            : {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              },
      }),
    );
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  });
  return {
    hits,
    host: `127.0.0.1:${address.port}`,
    url: `http://127.0.0.1:${address.port}/mcp`,
    refuse: () => {
      refuse = true;
    },
  };
}

async function workspace(
  t: { after: (fn: () => unknown) => void },
  name: string,
) {
  const root = await mkdtemp(join(tmpdir(), `void-tui-${name}-`));
  const env = { VOID_DATA_DIR: root };
  const app = new Workbench(env, assistant);
  t.after(async () => {
    await app.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-private",
  });
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  const last = () => app.connectionState().connectors.at(-1)!;
  return { app, ui, last };
}

test("/mcp lists every connector with its consent state and next step", async (t) => {
  const { app, ui, last } = await workspace(t, "mcp-list");
  const server = await upstream(t);
  await ui.command(`/mcp add ${server.url} counter`);
  const id = last().id;
  let text = ui.lines().join("\n");
  assert.match(text, /counter +staged +0 tools/);
  assert.match(text, new RegExp(`next: /mcp probe ${id}`));
  // The document workspace shares this list and has no endpoint of its own.
  assert.match(text, /VOID documents +confirmed +4 tools/);
  assert.match(text, /in use: the VOID document workspace/);

  await app.probeConnector(id);
  await ui.command("/mcp");
  text = ui.lines().join("\n");
  assert.match(text, /counter +probed +1 tools/);
  assert.match(text, new RegExp(`next: /mcp confirm ${id}`));

  await app.confirmConnector(id);
  await ui.command("/mcp");
  text = ui.lines().join("\n");
  assert.match(text, /counter +confirmed +1 tools/);
  assert.match(text, /in use by new conversations/);
  for (const line of ui.lines()) assert.ok(visibleLength(line) <= 80, line);
});

test("/mcp probe names the host and sends nothing until it is confirmed", async (t) => {
  const { ui, last } = await workspace(t, "mcp-probe");
  const server = await upstream(t);
  await ui.command(`/mcp add ${server.url} counter`);
  const id = last().id;

  await ui.command(`/mcp probe ${id}`);
  assert.ok(ui.confirmation, "a probe must be reviewed before it runs");
  assert.match(ui.confirmation.lines.join("\n"), new RegExp(server.host));
  assert.match(ui.confirmation.lines.join("\n"), /Declining sends no request/);
  assert.deepEqual(server.hits, []);

  ui.reject();
  assert.deepEqual(server.hits, []);
  assert.equal(last().consentState, "staged");
  assert.equal(last().tools.length, 0);

  await ui.command(`/mcp probe ${id}`);
  await ui.confirm();
  assert.deepEqual(server.hits, [
    "initialize",
    "notifications/initialized",
    "tools/list",
  ]);
  assert.equal(last().consentState, "probed");
  assert.equal(last().tools.length, 1);
  assert.match(ui.notice, /listed 1 tools/);
  assert.match(ui.detail!.join("\n"), new RegExp(`next: /mcp confirm ${id}`));
});

test("/mcp probe reports a refused exchange and keeps the connector staged", async (t) => {
  const { ui, last } = await workspace(t, "mcp-refused");
  const server = await upstream(t);
  await ui.command(`/mcp add ${server.url} counter`);
  const id = last().id;
  server.refuse();
  await ui.command(`/mcp probe ${id}`);
  await ui.confirm();
  const shown = ui.detail!.join("\n");
  assert.match(shown, /REFUSED/);
  assert.match(shown, /HTTP 500/);
  assert.match(shown, /stays staged/);
  assert.match(ui.notice, /Probe refused/);
  assert.equal(last().consentState, "staged");
  assert.equal(last().tools.length, 0);
});

test("/mcp add stages locally, contacts nothing and rejects a bad argument", async (t) => {
  const { app, ui, last } = await workspace(t, "mcp-add");
  const server = await upstream(t);
  await ui.command(`/mcp add ${server.url} counter server`);
  assert.equal(last().name, "counter server");
  assert.equal(last().consentState, "staged");
  assert.deepEqual(server.hits, []);
  assert.match(ui.detail!.join("\n"), /Nothing was contacted/);
  assert.match(ui.notice, /No request was made/);
  assert.equal(app.connectionState().connectors.length, 2);

  await assert.rejects(ui.command("/mcp add"), /\/mcp add https:\/\/host\/mcp/);
  await assert.rejects(
    ui.command("/mcp add counter"),
    /\/mcp add https:\/\/host\/mcp/,
  );
  assert.deepEqual(server.hits, []);
});

test("only a confirmed connector reaches a new conversation", async (t) => {
  const { app, ui, last } = await workspace(t, "mcp-tools");
  const server = await upstream(t);
  await ui.command(`/mcp add ${server.url} counter`);
  const id = last().id;
  const configured = () =>
    app.availableTools().tools.map((tool) => tool.name);

  await ui.command("what can you do");
  await app.settled();
  const started = app
    .availableTools(ui.sessionId!)
    .tools.map((tool) => tool.name);
  assert.ok(started.includes("void_workspace_list"));
  assert.ok(!started.includes("fixture_send"));
  assert.deepEqual(server.hits, [], "a staged connector is never connected");

  await ui.command(`/mcp probe ${id}`);
  await ui.confirm();
  assert.ok(
    !configured().includes("fixture_send"),
    "a probed catalog still gives a new conversation nothing",
  );

  await ui.command(`/mcp confirm ${id}`);
  await ui.confirm();
  assert.ok(
    configured().includes("fixture_send"),
    "a confirmed catalog reaches a new conversation",
  );
});

test("no rendered line carries the connector token", async (t) => {
  const { app, ui, last } = await workspace(t, "mcp-secret");
  const server = await upstream(t);
  await app.addConnector({
    url: server.url,
    token: SECRET,
    facts: { "hold.released": true },
    mapping: { fixture_send: "aws.ses.email.send" },
  });
  const id = last().id;
  for (const command of ["/mcp", `/mcp inspect ${id}`, "/mcp inspect workspace"]) {
    await ui.command(command);
    const shown = [
      ...ui.lines(),
      ui.notice,
      ...ui.items().flatMap((row) => [row.label, ...row.lines]),
    ].join("\n");
    assert.ok(!shown.includes(SECRET), command);
  }
  await ui.command(`/mcp probe ${id}`);
  await ui.confirm();
  await ui.command(`/mcp inspect ${id}`);
  assert.match(
    ui.detail!.join("\n"),
    /mapping {1}fixture_send -> aws.ses.email.send/,
  );
  assert.match(ui.detail!.join("\n"), /tools 1: fixture_send/);
  const frame = stripAnsi(renderWorkspace(ui, 100, 40, "_", true, true));
  assert.ok(!frame.includes(SECRET), frame);
});

test("/mcp inspect shows what the policy would decide, and admits an unknown radius", async (t) => {
  const { app, ui, last } = await workspace(t, "mcp-preview");
  const server = await upstream(t);
  await app.addConnector({
    url: server.url,
    name: "counter",
    mapping: { fixture_send: "aws.ses.email.send" },
    facts: { "hold.released": true },
  });
  const id = last().id;
  await ui.command(`/mcp inspect ${id}`);
  assert.doesNotMatch(
    ui.detail!.join("\n"),
    /decisions/,
    "a staged connector has no catalog to judge",
  );

  await app.probeConnector(id);
  await ui.command(`/mcp inspect ${id}`);
  const shown = ui.detail!.join("\n");
  assert.match(shown, /decisions \d+ allow, \d+ held, \d+ denied/);
  assert.match(shown, /fixture_send +\w+ +r[0-3]/);
  assert.match(shown, /radius unknown/);
  for (const line of ui.detail!) assert.ok(visibleLength(line) <= 80, line);
});

test("/mcp rename re-stages and /mcp remove deletes after a review", async (t) => {
  const { app, ui, last } = await workspace(t, "mcp-edit");
  const server = await upstream(t);
  await ui.command(`/mcp add ${server.url} counter`);
  const id = last().id;
  await app.probeConnector(id);
  await app.confirmConnector(id);

  await ui.command(`/mcp rename ${id} invoice sender`);
  assert.equal(last().name, "invoice sender");
  assert.equal(last().consentState, "staged");
  assert.equal(last().tools.length, 0);
  assert.match(ui.notice, /staged again/);
  await assert.rejects(ui.command(`/mcp rename ${id}`), /new-name/);
  await assert.rejects(ui.command(`/mcp confirm ${id}`), /is staged/);

  await ui.command(`/mcp remove ${id}`);
  assert.ok(ui.confirmation, "a removal is reviewed before it runs");
  ui.reject();
  assert.equal(last().id, id, "declining keeps the connector");
  await ui.command(`/mcp remove ${id}`);
  await ui.confirm();
  assert.equal(app.connectionState().connectors.length, 1);
  assert.match(ui.notice, /removed/);
  await assert.rejects(ui.command("/mcp remove workspace"), /built in/);
});

test("an unknown /mcp command or id answers with the usage block", async (t) => {
  const { ui, last } = await workspace(t, "mcp-usage");
  await ui.command("/mcp frobnicate");
  let text = ui.detail!.join("\n");
  assert.match(text, /Unknown connector command: frobnicate/);
  assert.match(text, /\/mcp add URL \[name\] stages one/);
  await ui.command("/mcp inspect missing-id");
  text = ui.detail!.join("\n");
  assert.match(text, /Unknown connector: missing-id/);
  assert.match(text, new RegExp(`KNOWN CONNECTORS\\n {2}${last().id}`));
  assert.match(ui.notice, /usage block is on screen/);
});

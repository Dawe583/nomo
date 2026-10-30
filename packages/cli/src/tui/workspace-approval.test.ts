import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Workbench } from "../../../workbench/src/index.ts";
import { WorkspaceTui } from "./workspace.ts";

test("TUI approvals dispatch once only after confirmation; denial, cancellation and restart cannot release a tool", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-approval-"));
  let dispatched = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const b = JSON.parse(raw);
    if (b.method === "tools/call") dispatched++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: b.id,
        result:
          b.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "local-fixture", version: "1" },
              }
            : b.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "fixture_send",
                      description: "Counter fixture only, no email is sent.",
                      inputSchema: {
                        type: "object",
                        properties: { text: { type: "string" } },
                      },
                    },
                  ],
                }
              : {
                  content: [
                    { type: "text", text: "fixture counter incremented" },
                  ],
                },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { NOMO_DATA_DIR: root };
  const app = new Workbench(env, async (url, options) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const b = JSON.parse(String(options?.body));
    const tool = b.tools.find((t: { function: { description: string } }) =>
      t.function.description.startsWith("fixture_send:"),
    );
    return Response.json({
      choices: [
        {
          message:
            b.messages.at(-1).role === "tool"
              ? { role: "assistant", content: "Tool outcome received." }
              : {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "counter",
                      type: "function",
                      function: {
                        name: tool.function.name,
                        arguments: '{"text":"local test"}',
                      },
                    },
                  ],
                },
          finish_reason:
            b.messages.at(-1).role === "tool" ? "stop" : "tool_calls",
        },
      ],
    });
  });
  t.after(async () => {
    await app.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await app.configure({
    baseUrl: "https://fixture.test/v1",
    apiKey: "fixture-private",
  });
  await app.addConnector({
    url: `http://127.0.0.1:${address.port}`,
    mapping: { fixture_send: "aws.ses.email.send" },
    facts: { "hold.released": true },
  });
  // The builtin document workspace shares this list and has no url.
  const conn = app.connectionState().connectors.find(
    (c) => "url" in c && !!c.url?.includes(String(address.port)),
  )!;
  await app.probeConnector(conn.id);
  await app.confirmConnector(conn.id);
  const ui = new WorkspaceTui(app, env);
  await ui.initialize();
  async function held() {
    await ui.command("/new Request the fixture tool.");
    const until = Date.now() + 4000;
    while (!app.pending().length && Date.now() < until) await delay(10);
    assert.equal(app.pending().length, 1);
    ui.choose("approvals");
    return app.pending()[0]!;
  }
  const first = await held();
  assert.match(JSON.stringify(ui.items()), /local test/);
  ui.prepareApproval("approved", first.holdId);
  assert.equal(dispatched, 0);
  await ui.confirm();
  await app.settled();
  assert.equal(dispatched, 1);
  assert.equal(
    app.decide(first.holdId, { kind: "approved", by: "again" }),
    false,
  );
  const proof = await app.ledger(app.get(ui.sessionId!)!.workspace);
  assert.ok(
    proof?.entries.some(
      (e) =>
        (e.body as Record<string, unknown>).decision === "hold:approved" &&
        (e.body as Record<string, unknown>).approvedBy === "tui-operator",
    ),
  );
  const second = await held();
  ui.prepareApproval("denied", second.holdId);
  await ui.confirm();
  await app.settled();
  assert.equal(dispatched, 1);
  const third = await held();
  const recoveredDir = join(root, "snapshot");
  await mkdir(recoveredDir);
  for (const file of ["workspace.key", "workspace.enc"])
    await copyFile(join(root, file), join(recoveredDir, file));
  const recovered = new Workbench({ NOMO_DATA_DIR: recoveredDir });
  assert.equal(recovered.pending().length, 0);
  assert.ok(
    recovered
      .approvals()
      .some(
        (h) =>
          "holdId" in h &&
          h.holdId === third.holdId &&
          h.status === "interrupted",
      ),
  );
  assert.equal(
    recovered.decide(third.holdId, { kind: "approved", by: "after-restart" }),
    false,
  );
  await recovered.shutdown();
  app.cancel(ui.sessionId!);
  assert.equal(app.pending().length, 0);
  assert.equal(
    app.decide(third.holdId, { kind: "approved", by: "late" }),
    false,
  );
  await app.settled();
  assert.equal(dispatched, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";
import { Workbench } from "./index.ts";
import {
  page,
  filterRows,
  preferencePatch,
  deriveRunState,
  capabilities,
  activity,
  providerStateFromFailure,
} from "./gui.ts";
import { assertIsolated, isolatedWorkbench } from "./test-fixture.ts";

test("cursor binds filters and preserves position when new rows arrive; finds old results", () => {
  const rows = Array.from({ length: 151 }, (_, i) => ({
    id: String(i),
    title: i === 150 ? "Old needle" : "Conversation",
  }));
  const first = page(rows, new URLSearchParams("limit=50"));
  const next = page(
    [{ id: "new", title: "New" }, ...rows],
    new URLSearchParams({ limit: "50", cursor: first.nextCursor! }),
  );
  assert.equal(next.items[0]!.id, "50");
  assert.equal(first.total, 151);
  assert.equal(
    page(
      filterRows(rows, new URLSearchParams("q=needle")),
      new URLSearchParams("q=needle"),
    ).items[0]!.id,
    "150",
  );
  assert.throws(
    () =>
      page(
        rows,
        new URLSearchParams({ q: "changed", cursor: first.nextCursor! }),
      ),
    /cursor/,
  );
  assert.throws(() => preferencePatch({ appearance: "unknown" }), /appearance/);
});
test("permission mode is server authoritative and fails closed",()=>{
 assert.equal(capabilities("local").permissionMode,"read-only");
 assert.equal(capabilities("local").permissionModeAuthority,"server");
 assert.equal(capabilities("local","normal").permissionMode,"normal");
 assert.throws(()=>preferencePatch({permissionMode:"plan"}),/server-controlled/);
});

test("GUI edits use revisions and signed undo, branches do not replay tools, requests survive restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-gui-"));
  let requests = 0;
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "test" }] })
      : (requests++,
        Response.json({
          choices: [{ message: { role: "assistant", content: "Complete." } }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }));
  let wb = new Workbench({ NOMO_DATA_DIR: directory, NOMO_PERMISSION_MODE: "normal" }, fetcher);
  assertIsolated(directory, { NOMO_DATA_DIR: directory, NOMO_PERMISSION_MODE: "normal" });
  t.after(async () => {
    wb.close();
    await rm(directory, { recursive: true, force: true });
  });
  await wb.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: "secret-test",
  });
  const session = await wb.start("First", "test", "request-one");
  while (wb.get(session.id)?.status === "running") await delay(5);
  assert.equal((await wb.start("First", "test", "request-one")).id, session.id);
  assert.equal(requests, 1);
  await assert.rejects(
    wb.start("Different", "test", "request-one"),
    /another request/,
  );
  const first = await wb.editDocument(session.id, {
    path: "notes.md",
    content: "First version",
    expectedRevision: null,
  });
  await assert.rejects(
    wb.editDocument(session.id, {
      path: "notes.md",
      content: "Overwrite",
      expectedRevision: null,
    }),
    /revision conflict/,
  );
  const second = await wb.editDocument(session.id, {
    path: "notes.md",
    content: "Second version",
    expectedRevision: first.revision,
  });
  assert.equal((await wb.ledger(session.workspace))?.result.ok, true);
  const child = await wb.branch(session.id, {
    seq: 1,
    prompt: "Edited prompt",
    snapshotDocuments: true,
    idempotencyKey: "branch-unkeyed-test",
  });
  assert.equal(child.status, "idle");
 const keyed = { seq: 1, prompt: "Keyed branch", snapshotDocuments: true, idempotencyKey: "branch-key" };
 const keyedFirst = await wb.branch(session.id, keyed as Parameters<Workbench["branch"]>[1]);
 const keyedRetry = await wb.branch(session.id, keyed as Parameters<Workbench["branch"]>[1]);
 assert.equal(keyedRetry.id, keyedFirst.id);
 await assert.rejects(wb.branch(session.id, { seq: 1 } as Parameters<Workbench["branch"]>[1]), /Idempotency key/);
 await assert.rejects(wb.branch(session.id, { ...keyed, prompt: "Changed payload" } as Parameters<Workbench["branch"]>[1]), /Idempotency key/);
 const internals = wb as unknown as { sessions: Map<string, { view: { status: string } }>; jobs: Map<string, Promise<void>> };
 const parentView = internals.sessions.get(session.id)!.view;
 for (const status of ["unknown", "paused"]) {
   parentView.status = status;
  await assert.rejects(wb.branch(session.id, { seq: 1, idempotencyKey: `blocked-${status}` } as Parameters<Workbench["branch"]>[1]), /unknown|paused|reconcil|settle/i);
 }
 parentView.status = "cancelled";
 internals.jobs.set(session.id, Promise.resolve());
 await assert.rejects(wb.branch(session.id, { seq: 1, idempotencyKey: "active-run" } as Parameters<Workbench["branch"]>[1]), /active run|settle/i);
 internals.jobs.delete(session.id);
 parentView.status = "idle";
  assert.equal(requests, 1);
  assert.equal(wb.document(child.id, "notes.md").content, "Second version");
  assert.equal((await wb.ledger(child.workspace))?.result.ok, true);
  assert.equal(
    (await wb.undoPreview(session.id, second.revision!)).canApply,
    true,
  );
  await wb.undo(session.id, second.revision!);
  assert.equal(wb.document(session.id, "notes.md").content, "First version");
  wb.patchSession(session.id, {
    title: "Renamed",
    pinned: true,
    archived: true,
  });
  wb.patchPreferences({ locale: "en" });
  wb.close();
  wb = new Workbench({ NOMO_DATA_DIR: directory }, fetcher);
  assertIsolated(directory, { NOMO_DATA_DIR: directory });
  assert.equal(wb.getPreferences().locale, "en");
  assert.equal(wb.sessionPage(new URLSearchParams("archived=true")).total, 1);
  assert.equal((await wb.start("First", "test", "request-one")).id, session.id);
  assert.equal(requests, 1);
});

test("provider 429 persists Retry-After and never retries the generation", async (t) => {
  let calls = 0;
  const { app: wb } = await isolatedWorkbench(
    t,
    async (url) =>
      String(url).endsWith("/models")
        ? Response.json({ data: [{ id: "test" }] })
        : (calls++,
          new Response("private provider failure", {
            status: 429,
            headers: { "retry-after": "7" },
          })),
    {},
    { baseUrl: "https://provider.test/v1", apiKey: "test-secret", prefix: "nomo-rate-" },
  );
  const session = await wb.start("Hello", "test");
  while (wb.get(session.id)?.status === "running") await delay(5);
  const failure = wb
    .get(session.id)!
    .events.find((e) => e.type === "run.error");
  assert.equal(failure?.payload?.retryAfter, 7);
  assert.equal(failure?.payload?.status, 429);
  assert.equal(failure?.payload?.automaticRetry, false);
  assert.equal(calls, 1);
  assert.doesNotMatch(failure?.text ?? "", /private provider failure/);
});

test("a connector keeps its secret, exposes its schema, and only an explicit probe contacts the server", async (t) => {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    methods.push(body.method);
    assert.equal(req.headers.authorization, "Bearer connector-private");
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
                    name: "search",
                    description: "connector-private",
                    inputSchema: {
                      type: "object",
                      properties: { q: { type: "string" } },
                    },
                  },
                ],
              }
            : {},
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const { app: wb } = await isolatedWorkbench(t, undefined, {}, {
    configure: false,
    prefix: "nomo-connector-",
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await wb.addConnector({
    url: `http://127.0.0.1:${address.port}/mcp`,
    name: "Original",
    token: "connector-private",
    facts: { safe: true },
    mapping: { search: "search.read" },
  });
  const id = wb.connectionState().connectors.find((c) => c.id !== "workspace")!.id;
  let listed = wb.connectionState().connectors.find((c) => c.id === id)!;
  assert.equal(listed.consentState, "staged");
  assert.deepEqual(listed.tools, []);
  assert.deepEqual(methods, [], "adding a connector contacts nothing");

  await wb.probeConnector(id);
  listed = wb.connectionState().connectors.find((c) => c.id === id)!;
  assert.equal(listed.consentState, "probed");
  assert.equal(listed.toolDetails[0]?.name, "search");
  assert.deepEqual(listed.toolDetails[0]?.inputSchema, {
    type: "object",
    properties: { q: { type: "string" } },
  });
  assert.ok(
    methods.every((method) =>
      ["initialize", "notifications/initialized", "tools/list"].includes(method),
    ),
  );

  await wb.confirmConnector(id);
  listed = wb.connectionState().connectors.find((c) => c.id === id)!;
  assert.equal(listed.consentState, "confirmed");

  const changed = await wb.updateConnector(id, {
    name: "Changed",
    token: "",
    facts: { safe: false },
  });
  assert.equal(changed.name, "Changed");
  const restaged = wb.connectionState().connectors.find((c) => c.id === id)!;
  assert.equal(restaged.consentState, "staged");
  assert.deepEqual(
    restaged.tools,
    [],
    "an edit drops the catalog until it is probed again",
  );
  assert.doesNotMatch(JSON.stringify(changed), /connector-private/);

  assert.equal((await wb.testConnector(id)).ok, true);
  assert.equal(
    wb.connectionState().connectors.find((c) => c.id === id)!.consentState,
    "staged",
    "testing a connector does not confirm it",
  );
  await assert.rejects(
    wb.updateConnector(id, { mapping: { search: true } }),
    /mapping/,
  );
});

test("deriveRunState maps status strings to discriminated RunState", () => {
  const { deriveRunState: _deriveRunState } = { deriveRunState };
  assert.equal(deriveRunState("running", []), "running");
  assert.equal(
    deriveRunState("running", [
      { text: "waiting for your approval", type: "run.status" },
    ]),
    "awaiting-approval",
  );
  assert.equal(deriveRunState("cancelled", []), "stopped");
  assert.equal(deriveRunState("stopping", []), "stopping");
  assert.equal(deriveRunState("paused", []), "paused");
  assert.equal(deriveRunState("failed", []), "failed");
  assert.equal(deriveRunState("unknown", []), "unknown");
  assert.equal(deriveRunState("idle", []), "idle");
  assert.equal(deriveRunState("weird", []), "idle");
});

test("activity returns runs with state, progress, reconcileRequired", () => {
  const views = [
    {
      id: "s1",
      model: "m1",
      status: "running",
      createdAt: "2024-01-01T00:00:00.000Z",
      events: [
        {
          seq: 1,
          at: "2024-01-01T00:00:00.000Z",
          kind: "user",
          text: "hi",
          type: "message.completed",
        },
        {
          seq: 2,
          at: "2024-01-01T00:00:01.000Z",
          kind: "tool",
          text: "",
          type: "tool.started",
          payload: { progress: 0.5 },
        },
        {
          seq: 3,
          at: "2024-01-01T00:00:02.000Z",
          kind: "tool",
          text: "",
          type: "tool.result",
        },
      ],
    },
  ];
  const result = activity(views);
  assert.equal(result.runs.length, 1);
  const run = result.runs[0]!;
  assert.equal(run.state, "running");
  assert.equal(run.progress, 0.5);
  assert.equal(run.reconcileRequired, false);
  assert.ok("durationMs" in run);
});

test("activity sets reconcileRequired true for unknown status", () => {
  const views = [
    {
      id: "s1",
      model: "m1",
      status: "unknown",
      createdAt: "2024-01-01T00:00:00.000Z",
      events: [
        {
          seq: 1,
          at: "2024-01-01T00:00:00.000Z",
          kind: "tool",
          text: "",
          type: "tool.started",
        },
      ],
    },
  ];
  const result = activity(views);
  assert.equal(result.runs[0]!.reconcileRequired, true);
  assert.equal(result.runs[0]!.state, "unknown");
});

test("activity clamps progress outside 0..1 to null", () => {
  // use static import
  const views = [
    {
      id: "s1",
      model: "m1",
      status: "running",
      createdAt: "2024-01-01T00:00:00.000Z",
      events: [
        {
          seq: 1,
          at: "2024-01-01T00:00:00.000Z",
          kind: "tool",
          text: "",
          type: "tool.started",
          payload: { progress: 1.5 },
        },
      ],
    },
  ];
  const result = activity(views);
  assert.equal(result.runs[0]!.progress, null);
});

test("providerStateFromFailure maps 429 to rate-limited with retryAt", () => {
  // use static import
  const result = providerStateFromFailure(
    false,
    { status: 429, retryAfter: 30 },
    false,
  );
  assert.equal(result.status, "rate-limited");
  assert.ok(result.retryAt !== null);
  assert.equal(new Date(result.retryAt!).getTime() > Date.now(), true);
});

test("providerStateFromFailure maps no credential to setup-required", () => {
  // use static import
  const result = providerStateFromFailure(false, null, false);
  assert.equal(result.status, "setup-required");
  assert.equal(
    result.detail,
    "No credential is configured for the default provider.",
  );
  assert.equal(result.retryAt, null);
});

test("providerStateFromFailure maps other failure to unavailable with text", () => {
  const result = providerStateFromFailure(
    false,
    { status: 403, retryAfter: undefined },
    true,
  );
  assert.equal(result.status, "unavailable");
  assert.ok(result.detail !== null);
  assert.equal(result.retryAt, null);
});

test("providerStateFromFailure ready when connected", () => {
  // use static import
  const result = providerStateFromFailure(true, null, true);
  assert.equal(result.status, "ready");
  assert.equal(result.detail, null);
  assert.equal(result.retryAt, null);
});

test("activity uses projected state only for the current run",()=>{
 const views=[{id:"session",model:"fixture",status:"running",state:"awaiting-approval" as const,runId:"current",events:[
  {seq:1,at:"2026-09-22T00:00:00Z",kind:"tool",runId:"old",type:"run.status",payload:{status:"unknown"}},
  {seq:2,at:"2026-09-22T00:00:01Z",kind:"tool",runId:"current",type:"run.status",payload:{status:"running"}},
 ]}];
 const runs=activity(views).runs;
 assert.equal(runs.find(run=>run.runId==="current")?.state,"awaiting-approval");
 assert.equal(runs.find(run=>run.runId==="old")?.state,"unknown");
 assert.equal(runs.find(run=>run.runId==="old")?.reconcileRequired,true);
});

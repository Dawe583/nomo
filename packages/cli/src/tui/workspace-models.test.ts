import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../../workbench/src/index.ts";
import { renderWorkspace, WorkspaceTui } from "./workspace.ts";
import { stripAnsi } from "./layout.ts";

const providerUrl = "https://provider-a.test/v1";
const apiKey = "fixture-only-key";
const catalog = (models: readonly { id: string; name: string }[]) =>
  Response.json({ data: models });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function configuredUi(t: TestContext, fetcher: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "nomo-tui-models-"));
  const app = new Workbench({ NOMO_DATA_DIR: directory }, fetcher);
  await app.configure({ baseUrl: providerUrl, apiKey });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: directory });
  await ui.initialize();
  t.after(async () => {
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, ui };
}

test("Models entry replaces cached rows with every current connected-provider model", async (t) => {
  const replies = [
    [
      { id: "current-one", name: "Current One" },
      { id: "current-two", name: "Current Two" },
    ],
  ] as const;
  let requests = 0;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/models")) {
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        `Bearer ${apiKey}`,
        "a refresh reuses Workbench's stored credential without exposing it in TUI state",
      );
      return catalog(replies[Math.min(requests++, replies.length - 1)]!);
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  };
  const { ui } = await configuredUi(t, fetcher);

  ui.choose("models");
  await tick();

  assert.equal(
    requests,
    1,
    "the picker uses the provider catalog already loaded by Workbench",
  );
  const rows = ui.items();
  assert.deepEqual(
    rows.map((row) => row.id),
    ["current-one", "current-two"],
  );
  assert.match(rows[0]!.label, /Current One.*current-one/i);
  assert.match(
    rows[0]!.label,
    /\[\*\]/,
    "the Workbench-selected model remains explicit",
  );
  assert.doesNotMatch(rows.map((row) => row.label).join("\n"), /retired-model/);
});

test("Models rows show configured provider sections but only active-provider models", async (t) => {
  const requests: string[] = [];
  const directory = await mkdtemp(
    join(tmpdir(), "nomo-tui-provider-sections-"),
  );
  const app = new Workbench({ NOMO_DATA_DIR: directory }, async (input) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      requests.push(url);
      return catalog([
        { id: "shared", name: "Shared" },
        { id: "shared", name: "Duplicate" },
      ]);
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  });
  await app.configure({
    baseUrl: "https://first.test/v1",
    apiKey: "first-secret",
  });
  await app.configure({
    baseUrl: "https://second.test/v1",
    apiKey: "second-secret",
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: directory });
  await ui.initialize();
  t.after(async () => {
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  ui.choose("models");
  await tick();
  const rows = ui.items();
  assert.deepEqual(
    rows.map((row) => row.id),
    ["shared"],
  );
  assert.deepEqual(ui.modelProjection, {
    activeProviderId: "https://second.test/v1",
    providers: [
      {
        id: "https://first.test/v1",
        name: "https://first.test/v1",
        configured: true,
        attached: false,
        catalogStatus: "idle",
        models: [],
      },
      {
        id: "https://second.test/v1",
        name: "https://second.test/v1",
        configured: true,
        attached: true,
        catalogStatus: "ready",
        models: [{ id: "shared", name: "Shared" }],
      },
    ],
  });
  assert.equal(
    requests.length,
    2,
    "reading or rendering Models does not probe providers",
  );
  assert.doesNotMatch(
    JSON.stringify(ui.modelProjection),
    /first-secret|second-secret/,
  );
});

test("/model applies only a model from the current connected-provider catalog", async (t) => {
  let requests = 0;
  const { app, ui } = await configuredUi(t, async (input) => {
    if (String(input).endsWith("/models")) {
      requests++;
      return catalog([{ id: "current-model", name: "Current" }]);
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  });

  await assert.rejects(
    ui.command("/model unlisted-model"),
    /current connected-provider model/i,
  );
  await ui.command("/model current-model");

  assert.equal(
    requests,
    1,
    "selection uses the validated Workbench catalog without probing again",
  );
  assert.equal(ui.model, "current-model");
  assert.equal((await app.providerState()).defaultModel, "current-model");
});

test("Models after local logout hide stale provider and model rows", async (t) => {
  let requests = 0;
  const { ui } = await configuredUi(t, async (input) => {
    if (String(input).endsWith("/models")) {
      requests++;
      return catalog([{ id: "last-known-model", name: "Last known" }]);
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  });
  const requestsBeforeLogout = requests;
  await ui.command("/logout");
  assert.equal(
    requests,
    requestsBeforeLogout,
    "logout does not contact a provider",
  );
  ui.choose("models");

  assert.deepEqual(ui.items(), [], "stale provider models are not selectable");
  const frame = stripAnsi(
    renderWorkspace(ui, 120, 40, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.match(frame, /connect/i);
  assert.doesNotMatch(frame, /last-known-model|ready · active/);
});

test("Models view with no connected provider does not request a catalog", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-tui-no-provider-"));
  let requests = 0;
  const app = new Workbench({ NOMO_DATA_DIR: directory }, async (input) => {
    if (String(input).endsWith("/models")) requests++;
    return catalog([]);
  });
  const ui = new WorkspaceTui(app, { NOMO_DATA_DIR: directory });
  t.after(async () => {
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  await ui.initialize();

  ui.choose("models");
  await tick();

  assert.equal(requests, 0);
  assert.deepEqual(ui.items(), []);
  const frame = stripAnsi(
    renderWorkspace(ui, 80, 24, "", false, false, {
      color: false,
      motion: false,
    }),
  );
  assert.match(frame, /connect/i);
});
test("/models opens a refreshed picker without leaving Chat and Escape cancels", async (t) => {
  const replies = [
    [
      { id: "fresh-one", name: "Fresh One" },
      { id: "fresh-two", name: "Fresh Two" },
    ],
  ] as const;
  let requests = 0;
  const { ui } = await configuredUi(t, async (input) =>
    String(input).endsWith("/models")
      ? catalog(replies[Math.min(requests++, replies.length - 1)]!)
      : Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
  );

  await ui.choose("chat");
  await ui.command("/models");

  assert.equal(ui.tab, "chat");
  assert.equal(ui.modelPicker?.open, true);
  assert.equal(requests, 1);
  assert.deepEqual(
    ui.modelPicker?.models.map((model) => model.id),
    ["fresh-one", "fresh-two"],
  );
  ui.closeModelPicker();
  assert.equal(ui.modelPicker, undefined);
  assert.equal(ui.model, "fresh-one");
});

test("picker selection persists the future model default and leaves active session unchanged", async (t) => {
  const { app, ui } = await configuredUi(t, async (input) =>
    String(input).endsWith("/models")
      ? catalog([
          { id: "fresh-one", name: "Fresh One" },
          { id: "fresh-two", name: "Fresh Two" },
        ])
      : Response.json({
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
  );
  const session = await app.start("Start a conversation", "fresh-one");
  for (let i = 0; i < 100 && app.get(session.id)?.status === "running"; i++)
    await tick();
  ui.sessionId = session.id;
  await ui.command("/models");

  await ui.selectModel("fresh-two");

  assert.equal(ui.model, "fresh-two");
  assert.equal(
    app.get(session.id)?.model,
    "fresh-one",
    "existing sessions keep their model snapshot",
  );
  assert.equal((await app.providerState()).defaultModel, "fresh-two");
  assert.equal(ui.modelPicker, undefined);
});

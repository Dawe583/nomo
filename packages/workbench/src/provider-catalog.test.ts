/**
 * The boundary these tests pin: a provider that cannot list models is not the
 * same thing as a provider that failed.
 *
 * Some OpenAI-compatible endpoints only route named models to completions and
 * answer `/models` with 404 (Puter), or with an empty list. For those, the
 * model the operator named stands in for the catalog, because the operator has
 * already made the choice a catalog would have offered. For every other probe
 * failure, refused connection, rejected credential, server error, malformed
 * body, the probe's own error must reach the operator: reporting a provider
 * as configured while its endpoint is unreachable is the failure mode this
 * boundary exists to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isolatedWorkbench } from "./test-fixture.ts";
import { PUTER_URL } from "./provider-defaults.ts";

test("a provider that answers 404 for its catalog accepts the model the operator named", async (t) => {
  const fetcher: typeof fetch = async () => new Response("no catalog", { status: 404 });
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    configure: false,
    prefix: "void-catalog-404-",
  });

  const models = await app.configure({
    baseUrl: PUTER_URL,
    apiKey: "",
    model: "fixture/named-model",
  });
  assert.deepEqual(models, [{ id: "fixture/named-model", name: "fixture/named-model" }]);
  const state = await app.providerState();
  assert.equal(state.connected, true);
  assert.equal(state.providerId, "puter");
  assert.equal(state.defaultModel, "fixture/named-model");
});

test("a 404 catalog with no named model keeps the previous configuration", async (t) => {
  const fetcher: typeof fetch = async () => new Response("no catalog", { status: 404 });
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    configure: false,
    prefix: "void-catalog-404-unnamed-",
  });

  await assert.rejects(
    app.configure({ baseUrl: PUTER_URL, apiKey: "" }),
    /Provider returned no available models/,
  );
  assert.equal((await app.providerState()).connected, false);
});

test("a refused credential is rethrown, never read as a missing catalog", async (t) => {
  const fetcher: typeof fetch = async () => new Response("denied", { status: 401 });
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    configure: false,
    prefix: "void-catalog-401-",
  });

  await assert.rejects(
    app.configure({
      baseUrl: PUTER_URL,
      apiKey: "wrong-fixture-key",
      model: "fixture/named-model",
    }),
    /Provider request failed \(HTTP 401\)/,
  );
  assert.equal((await app.providerState()).connected, false);
});

test("an empty catalog from a real endpoint uses the named model", async (t) => {
  const fetcher: typeof fetch = async () => Response.json({ data: [] });
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    configure: false,
    prefix: "void-catalog-empty-",
  });

  const models = await app.configure({
    baseUrl: "https://catalog-empty.test/v1",
    apiKey: "fixture-key",
    model: "fixture/named-model",
  });
  assert.deepEqual(models, [{ id: "fixture/named-model", name: "fixture/named-model" }]);
});

test("the provider's own catalog is the truth when it lists models", async (t) => {
  const fetcher: typeof fetch = async () =>
    Response.json({ data: [{ id: "listed-model", name: "Listed Model" }] });
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    configure: false,
    prefix: "void-catalog-listed-",
  });

  const models = await app.configure({
    baseUrl: PUTER_URL,
    apiKey: "",
    model: "fixture/named-model",
  });
  assert.deepEqual(models.map((model) => model.id), ["listed-model"]);
  assert.equal((await app.providerState()).defaultModel, "listed-model");
});

test("a DashScope key configures the Qwen preset through its catalog", async (t) => {
  const seen: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    seen.push(String(url));
    return String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "qwen3.8-flash", name: "Qwen 3.8 Flash" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  };
  const { app } = await isolatedWorkbench(
    t,
    fetcher,
    { DASHSCOPE_API_KEY: "dashscope-fixture-key" },
    { configure: false, prefix: "void-dashscope-catalog-" },
  );

  const state = await app.providerState();
  assert.equal(state.connected, true);
  assert.equal(state.providerId, "qwen");
  assert.equal(state.defaultModel, "qwen3.8-flash");
  assert.ok(seen.some((url) => url.includes("dashscope.aliyuncs.com")));
});

test("a DashScope catalog that answers 404 still configures the named Qwen model", async (t) => {
  const fetcher: typeof fetch = async (url) =>
    String(url).endsWith("/models")
      ? new Response("no catalog", { status: 404 })
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
  const { app } = await isolatedWorkbench(
    t,
    fetcher,
    { DASHSCOPE_API_KEY: "dashscope-fixture-key" },
    { configure: false, prefix: "void-dashscope-404-" },
  );

  const state = await app.providerState();
  assert.equal(state.connected, true);
  assert.equal(state.providerId, "qwen");
  assert.equal(state.defaultModel, "qwen3.8-flash");
});

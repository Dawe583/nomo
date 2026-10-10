import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";
import { CompatibleProvider, ProviderRequestError } from "./provider.ts";
import {
  FREE_MODEL_BY_ORIGIN,
  PROVIDER_PRESETS,
  TOKENROUTER_URL,
} from "./provider-defaults.ts";

/** The free model is named per origin, so the retry guard never has to guess
 * from a global default that no longer exists. */
const freeModel = FREE_MODEL_BY_ORIGIN["https://api.tokenrouter.com"];

async function workspace(t: test.TestContext, models: readonly string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "nomo-no-default-provider-"));
  const workbench = new Workbench(
    { NOMO_DATA_DIR: dir },
    async (url) =>
      String(url).endsWith("/models")
        ? Response.json({ data: models.map((id) => ({ id })) })
        : Response.json({
            choices: [
              { message: { role: "assistant", content: "Fixture reply" } },
            ],
          }),
  );
  t.after(async () => {
    workbench.close();
    await rm(dir, { recursive: true, force: true });
  });
  return workbench;
}

test("a workspace with no provider configured has no provider id and no model id", async (t) => {
  const workbench = await workspace(t);
  const state = await workbench.providerState();
  assert.equal(state.providerId, null);
  assert.equal(state.defaultModel, null);
  assert.equal(state.connected, false);
  assert.equal(state.setupRequired, true);
  // The preferences themselves carry no provider and no model to inherit.
  const preferences = workbench.getPreferences();
  assert.equal("defaultProvider" in preferences, false);
  assert.equal("defaultModel" in preferences, false);
  // Starting a conversation cannot fall back to a vendor's model either.
  await assert.rejects(workbench.start("Hello"), /Select a model/);
});

test("a configured provider is used verbatim and the catalog picks the model", async (t) => {
  const workbench = await workspace(t, ["first-model", "second-model"]);
  const models = await workbench.configure({
    baseUrl: TOKENROUTER_URL,
    apiKey: "fixture-secret",
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ["first-model", "second-model"],
  );
  const state = await workbench.providerState();
  assert.equal(state.providerId, "tokenrouter");
  assert.equal(state.baseUrl, TOKENROUTER_URL);
  assert.equal(state.defaultModel, "first-model");
  assert.equal(workbench.getPreferences().defaultProvider, "tokenrouter");
  // A hand-typed endpoint is reported as custom, never as a preset's vendor.
  await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: "fixture-secret",
  });
  const custom = await workbench.providerState();
  assert.equal(custom.providerId, "custom");
  assert.equal(custom.baseUrl, "https://provider.test/v1");
});

test("a model the operator picked is kept when the next provider serves it", async (t) => {
  const workbench = await workspace(t, ["first-model", "second-model"]);
  await workbench.configure({
    baseUrl: TOKENROUTER_URL,
    apiKey: "fixture-secret",
  });
  workbench.patchPreferences({ defaultModel: "second-model" });
  // The same catalog arrives for a different provider: the choice is the
  // operator's, so it survives instead of being replaced by the catalog head.
  const again = await workbench.configure({
    baseUrl: "https://provider.test/v1",
    apiKey: "fixture-secret",
  });
  assert.deepEqual(
    again.map((model) => model.id),
    ["first-model", "second-model"],
  );
  assert.equal((await workbench.providerState()).defaultModel, "second-model");
});

test("the presets stay a choice, and the free endpoints are named per origin", () => {
  assert.ok(PROVIDER_PRESETS.length >= 10);
  for (const preset of PROVIDER_PRESETS) {
    assert.ok(preset.id.length && preset.name.length);
    assert.ok(["compatible", "anthropic"].includes(preset.kind));
  }
  // TokenHarbor has no preset and is still a free origin, so the free table and
  // the preset list are two facts and neither one is a default.
  assert.equal(
    PROVIDER_PRESETS.some(
      (preset) => new URL(preset.baseUrl).origin === "https://tokenharbor.ai",
    ),
    false,
  );
});

test("the retry guard retries the free model and refuses every other model", async () => {
  for (const origin of Object.keys(FREE_MODEL_BY_ORIGIN)) {
    const served = FREE_MODEL_BY_ORIGIN[origin]!;
    let free = 0;
    const freeProvider = new CompatibleProvider(
      { baseUrl: `${origin}/v1`, apiKey: "fixture-secret" },
      async () => {
        free++;
        return free < 3
          ? new Response("fixture-secret", {
              status: 503,
              headers: { "retry-after": "0" },
            })
          : Response.json({
              choices: [
                { message: { role: "assistant", content: "Ready" } },
              ],
            });
      },
    );
    const reply = await freeProvider.complete(
      served,
      [],
      [],
      new AbortController().signal,
    );
    assert.equal(reply.message.content, "Ready", origin);
    assert.equal(free, 3, origin);
  }
  // A paid model, and a model the operator typed that is in no preset and no
  // table, are both dispatched once and never retried.
  for (const model of ["z-ai/glm-5.3", "operator/typed-model"]) {
    let calls = 0;
    const provider = new CompatibleProvider(
      { baseUrl: TOKENROUTER_URL, apiKey: "fixture-secret" },
      async () => {
        calls++;
        return new Response("fixture-secret", {
          status: 503,
          headers: { "retry-after": "0" },
        });
      },
    );
    await assert.rejects(
      provider.complete(model, [], [], new AbortController().signal),
      (error: unknown) => error instanceof ProviderRequestError,
      model,
    );
    assert.equal(calls, 1, model);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { provider, providerState } from "./provider.mjs";
import { DEFAULT_MODEL_ID, NVIDIA_URL, TOKENROUTER_URL } from "../packages/workbench/src/provider-defaults.ts";

function fixture(env = {}, saved) {
  const values = new Map(saved ? [["provider", saved]] : []), requests = [];
  const dependencies = {
    env,
    read: async (key) => values.get(key),
    write: async (key, value) => values.set(key, value),
    encrypt: JSON.stringify,
    decrypt: JSON.parse,
    oidc: async () => "fixture-oidc",
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return Response.json({ data: [{ id: DEFAULT_MODEL_ID }] });
    },
  };
  return { dependencies, requests, values };
}

test("cloud defaults use NVIDIA without falling back to legacy credentials", async () => {
  const f = fixture({ NVIDIA_API_KEY: "fixture-nvidia", TOKENROUTER_API_KEY: "fixture-legacy" });
  const state = await providerState(f.dependencies);
  assert.equal(state.status, "ready");
  assert.equal(state.connected, true);
  assert.equal(state.setupRequired, false);
  assert.equal(state.providerId, "nvidia");
  assert.equal(state.baseUrl, NVIDIA_URL);
  assert.equal(state.defaultModel, DEFAULT_MODEL_ID);
  assert.equal(f.requests[0].url, `${NVIDIA_URL}/models`);
  assert.equal(f.requests[0].options.headers.authorization, "Bearer fixture-nvidia");
  assert.doesNotMatch(JSON.stringify(state), /fixture-nvidia|fixture-legacy/);
});

test("missing NVIDIA credentials expose setup and make no provider request", async () => {
  const f = fixture({ TOKENROUTER_API_KEY: "fixture-legacy" });
  const state = await providerState(f.dependencies);
  assert.equal(state.status, "setup-required");
  assert.equal(state.setupRequired, true);
  assert.equal(state.connected, false);
  assert.equal(state.retryAt, null);
  assert.deepEqual(f.requests, []);
  await assert.rejects(provider(undefined, f.dependencies), /NVIDIA/);
});

test("legacy snapshots retain TokenRouter while new snapshots select NVIDIA", async () => {
  const f = fixture({ NVIDIA_API_KEY: "fixture-nvidia", TOKENROUTER_API_KEY: "fixture-legacy" });
  await (await provider({ mode: "tokenrouter" }, f.dependencies)).models();
  await (await provider({ mode: "nvidia" }, f.dependencies)).models();
  assert.equal(f.requests[0].url, `${TOKENROUTER_URL}/models`);
  assert.equal(f.requests[0].options.headers.authorization, "Bearer fixture-legacy");
  assert.equal(f.requests[1].url, `${NVIDIA_URL}/models`);
});

test("saved provider profiles survive the new default without mutation", async () => {
  const secret = JSON.stringify({ baseUrl: "https://provider.test/v1", apiKey: "fixture-profile", kind: "compatible" });
  const f = fixture({ NVIDIA_API_KEY: "fixture-nvidia" }, { secret });
  const state = await providerState(f.dependencies);
  assert.equal(state.providerId, "custom");
  assert.equal(state.baseUrl, "https://provider.test/v1");
  assert.equal(f.values.get("provider").secret, secret);
  assert.equal(f.requests[0].options.headers.authorization, "Bearer fixture-profile");
  assert.doesNotMatch(JSON.stringify(state), /fixture-profile/);
});

for (const status of [401, 403, 404, 429, 503]) {
  test(`cloud provider HTTP ${status} is structured and redacted`, async () => {
    const f = fixture({ NVIDIA_API_KEY: "fixture-nvidia" });
    f.dependencies.fetch = async () => new Response("private upstream payload fixture-nvidia", {
      status, headers: { "retry-after": "2" },
    });
    const state = await providerState(f.dependencies);
    assert.equal(state.status, status === 429 ? "rate-limited" : "unavailable");
    assert.equal(state.setupRequired, false);
    assert.equal(state.connected, false);
    assert.ok(state.detail);
    assert.doesNotMatch(JSON.stringify(state), /fixture-nvidia|private upstream/);
    if (status === 429) assert.ok(Date.parse(state.retryAt) > Date.now());
  });
}

test("disabled provider is not silently reconnected from the environment", async () => {
  const f = fixture({ NVIDIA_API_KEY: "fixture-nvidia" }, { disabled: true });
  const state = await providerState(f.dependencies);
  assert.equal(state.status, "setup-required");
  assert.equal(f.requests.length, 0);
});

test("storage and malformed profile errors do not expose secret error payloads", async () => {
  const f = fixture({ NVIDIA_API_KEY: "fixture-nvidia" });
  f.dependencies.read = async () => { throw new Error("private postgres credential"); };
  const state = await providerState(f.dependencies);
  assert.equal(state.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(state), /private postgres credential/);
});

test("runtime rate limits survive a successful catalog probe and remain provider scoped", async () => {
  const f = fixture({ NVIDIA_API_KEY: "fixture-nvidia" });
  const { rememberProviderFailure } = await import("./provider.mjs");
  await rememberProviderFailure({ mode: "nvidia" }, { status: 429, retryAfter: 3 }, undefined, f.dependencies);
  const limited = await providerState(f.dependencies);
  assert.equal(limited.status, "rate-limited");
  assert.equal(limited.connected, true);
  assert.ok(Date.parse(limited.retryAt) > Date.now());
  f.values.set("provider", { secret: JSON.stringify({ baseUrl: "https://provider.test/v1", apiKey: "fixture-other" }) });
  assert.equal((await providerState(f.dependencies)).status, "ready");
});

test("non-rate-limit provider failures never advertise a retry clock", async () => {
  const f = fixture({ NVIDIA_API_KEY: "fixture-nvidia" });
  const { rememberProviderFailure } = await import("./provider.mjs");
  await rememberProviderFailure({ mode: "nvidia" }, { status: 503, retryAfter: 10 }, undefined, f.dependencies);
  const state = await providerState(f.dependencies);
  assert.equal(state.status, "unavailable");
  assert.equal(state.retryAt, null);
});

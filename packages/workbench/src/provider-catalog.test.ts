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
import { BLOCKED_PROVIDER_APIS_BY_PROVIDER, IMPLEMENTED_PROVIDER_TRANSPORTS, PROVIDER_API_BLOCKERS } from "./provider-adapters/types.ts";
import { CONFIGURABLE_PROVIDER_DESCRIPTORS, PROVIDER_API_ROSTER, PROVIDER_MODEL_MANIFEST, PROVIDER_MODEL_PROVIDER_ROSTER, PROVIDER_SOURCE_BASELINE, PROVIDER_SOURCE_ROSTER } from "./provider-catalog.ts";

test("configurable descriptors exclude static Bedrock auth when the manifest does not list it", () => {
  assert.equal(
    CONFIGURABLE_PROVIDER_DESCRIPTORS.some(
      (descriptor) => descriptor.providerId === "amazon-bedrock",
    ),
    false,
  );
});


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

test("provider coverage roster matches the pinned OMP and Prime baselines", () => {
  assert.deepEqual(PROVIDER_SOURCE_ROSTER.omp, [
    "abliteration", "aiand", "aimlapi", "alibaba-coding-plan", "alibaba-token-plan",
    "amazon-bedrock", "anthropic", "apple", "azure", "baseten", "bedrock-mantle",
    "cerebras", "charm-hyper", "cline-pass", "cloudflare-ai-gateway", "commandcode",
    "coreweave", "cursor", "deepinfra", "deepseek", "devin", "factory-droid",
    "firepass", "fireworks", "github-copilot", "gitlab-duo", "gitlab-duo-agent",
    "gmi-cloud", "google", "google-antigravity", "google-gemini-cli", "google-vertex",
    "groq", "helmcode", "huggingface", "kilo", "kimi-code", "litellm", "lm-studio",
    "local", "meta", "minimax", "minimax-code", "minimax-code-cn", "mistral",
    "moonshot", "muse-code", "nanogpt", "novita", "nvidia", "ollama", "ollama-cloud",
    "openai", "openai-codex", "opencode-go", "opencode-zen", "openrouter", "qianfan",
    "qwen-portal", "sakana", "siliconflow", "siliconflow-cn", "singularityapi-dev",
    "singularityapi-tech", "stepfun", "synthetic", "together", "typesafe", "umans",
    "venice", "vercel-ai-gateway", "vllm", "wafer-serverless", "web", "xai", "xai-oauth",
    "xiaomi", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp",
    "yolo-auto", "zai", "zenmux", "zhipu-coding-plan",
  ]);
  assert.deepEqual(PROVIDER_SOURCE_ROSTER.prime, [
    "amazon-bedrock", "anthropic", "azure-openai-responses", "cerebras",
    "cloudflare-ai-gateway", "cloudflare-workers-ai", "deepseek", "fireworks",
    "github-copilot", "google", "google-vertex", "groq", "huggingface", "kimi-coding",
    "minimax", "minimax-cn", "mistral", "moonshotai", "moonshotai-cn", "openai",
    "openai-codex", "opencode", "opencode-go", "openrouter", "prime-inference",
    "vercel-ai-gateway", "xai", "xiaomi", "xiaomi-token-plan-ams",
    "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai",
  ]);
});

test("provider transport family roster matches the pinned source declarations", () => {
  assert.deepEqual(PROVIDER_SOURCE_BASELINE, { omp: "18.6.2", prime: "0.10.1" });
  assert.deepEqual(PROVIDER_API_ROSTER.omp, [
    "openai-completions", "openai-responses", "openrouter", "openai-codex-responses",
    "azure-openai-responses", "anthropic-messages", "bedrock-converse-stream",
    "google-generative-ai", "google-gemini-cli", "google-vertex", "ollama-chat",
    "cursor-agent", "factory-droid-agent", "gitlab-duo-agent", "devin-agent",
    "apple-foundation-models",
  ]);
  assert.deepEqual(PROVIDER_API_ROSTER.prime, [
    "openai-completions", "mistral-conversations", "openai-responses",
    "azure-openai-responses", "openai-codex-responses", "anthropic-messages",
    "bedrock-converse-stream", "google-generative-ai", "google-vertex",
  ]);
});

test("agent APIs stay distinct from model rows and Apple exposes its native platform blocker", () => {
  const providers = PROVIDER_MODEL_MANIFEST.providers;
  const apple = providers.find(provider => provider.source === "omp" && provider.providerId === "apple");
  assert.ok(apple);
  assert.equal(apple.status, "excluded");
  assert.equal(apple.models.length, 0);
  assert.match(apple.exclusionReason ?? "", /Workbench build does not link that bridge.*macOS 27/i);

  for (const api of [
    "cursor-agent", "factory-droid-agent", "gitlab-duo-agent", "devin-agent",
    "apple-foundation-models",
  ]) {
    assert.ok(PROVIDER_API_ROSTER.omp.includes(api as never), `${api} remains in OMP's API roster`);
    assert.equal(PROVIDER_API_ROSTER.prime.includes(api as never), false, `${api} is not a Prime API`);
  }
  assert.deepEqual(Object.keys(PROVIDER_API_BLOCKERS).sort(), [
    "apple-foundation-models", "cursor-agent", "devin-agent", "factory-droid-agent",
    "gitlab-duo-agent", "google-gemini-cli", "google-vertex", "openai-codex-responses",
  ]);
  assert.deepEqual(BLOCKED_PROVIDER_APIS_BY_PROVIDER, {
    "google-gemini-cli": "google-gemini-cli",
    "google-vertex": "google-vertex",
    "openai-codex": "openai-codex-responses",
    cursor: "cursor-agent",
    "factory-droid": "factory-droid-agent",
    "gitlab-duo-agent": "gitlab-duo-agent",
    devin: "devin-agent",
    apple: "apple-foundation-models",
  });
  assert.ok(PROVIDER_API_ROSTER.omp.includes("google-gemini-cli"));
  assert.equal(PROVIDER_API_ROSTER.prime.includes("google-gemini-cli" as never), false);
  assert.ok(PROVIDER_API_ROSTER.omp.includes("openai-codex-responses"));
  assert.ok(PROVIDER_API_ROSTER.prime.includes("openai-codex-responses"));


  const agentRows = providers.filter(provider =>
    provider.source === "omp" &&
    ["cursor", "factory-droid", "gitlab-duo-agent", "devin"].includes(provider.providerId),
  );
  assert.deepEqual(agentRows.map(provider => [provider.providerId, provider.status, provider.models.length]), [
    ["cursor", "in-scope", 123],
    ["devin", "in-scope", 2],
    ["factory-droid", "in-scope", 60],
    ["gitlab-duo-agent", "in-scope", 1],
  ]);
});
test("API availability manifest exactly covers both pinned API rosters", () => {
  const expected = Object.entries(PROVIDER_API_ROSTER).flatMap(([source, apiIds]) =>
    apiIds.map(apiId => `${source}:${apiId}`),
  ).sort();
  const actual = PROVIDER_MODEL_MANIFEST.apiTransports.map(row => `${row.source}:${row.apiId}`).sort();
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);

  const implemented = new Set<string>(IMPLEMENTED_PROVIDER_TRANSPORTS);
  for (const row of PROVIDER_MODEL_MANIFEST.apiTransports) {
    assert.ok(row.reason.length > 0);
    assert.ok(row.evidence.length > 0);
    assert.equal(
      row.status,
      implemented.has(row.apiId)
        ? "implemented"
        : row.apiId === "apple-foundation-models" ? "platform-unavailable" : "blocked",
      `${row.source}/${row.apiId}`,
    );
  }
  for (const apiId of Object.keys(PROVIDER_API_BLOCKERS)) {
    const row = PROVIDER_MODEL_MANIFEST.apiTransports.find(entry => entry.apiId === apiId);
    assert.ok(row);
    assert.equal(row.source, "omp");
    assert.equal(row.reason, PROVIDER_API_BLOCKERS[apiId as keyof typeof PROVIDER_API_BLOCKERS].reason);
  }
});

test("provider state exposes explicit unavailable APIs without probing a provider", async (t) => {
  let requests = 0;
  const { app } = await isolatedWorkbench(t, async () => {
    requests++;
    throw new Error("blocked provider APIs must not make requests");
  }, {}, { configure: false, prefix: "void-provider-api-blockers-" });
  const state = await app.providerState();
  assert.ok("unavailableProviders" in state);
  const unavailable = Reflect.get(state, "unavailableProviders") as Array<{
    apiId: string;
    name: string;
    source: string;
    status: string;
    reason: string;
    disabled: boolean;
  }>;
  const unavailableRows = unavailable.filter(provider =>
    ["cursor-agent", "devin-agent", "factory-droid-agent", "gitlab-duo-agent", "google-gemini-cli", "apple-foundation-models", "openai-codex-responses"].includes(provider.apiId),
  );
  assert.ok(unavailableRows.every(provider => provider.disabled));
  assert.deepEqual(
    unavailableRows.map(({ apiId, source, status, name }) => [apiId, source, status, name]).sort(),
    [
      ["apple-foundation-models", "omp", "platform-unavailable", "Apple Foundation Models"],
      ["cursor-agent", "omp", "blocked", "Cursor Agent"],
      ["devin-agent", "omp", "blocked", "Devin Agent"],
      ["factory-droid-agent", "omp", "blocked", "Factory Droid"],
      ["gitlab-duo-agent", "omp", "blocked", "GitLab Duo Agent"],
      ["google-gemini-cli", "omp", "blocked", "Google Gemini CLI / Cloud Code Assist"],
      ["openai-codex-responses", "omp", "blocked", "OpenAI Codex Responses"],
      ["openai-codex-responses", "prime", "blocked", "OpenAI Codex Responses"],
    ],
  );
  assert.match(
    unavailableRows.find(provider => provider.apiId === "apple-foundation-models")?.reason ?? "",
    /native pi-natives bridge.*macOS 27\+/i,
  );
  assert.match(
    unavailableRows.find(provider => provider.apiId === "openai-codex-responses")?.reason ?? "",
    /private backend route.*OAuth lifecycle.*API keys are not OAuth credentials/,
  );
  assert.match(
    unavailableRows.find(provider => provider.apiId === "google-gemini-cli")?.reason ?? "",
    /third-party Cloud Code contract.*OAuth lifecycle.*API[- ]key/i,
  );
  assert.equal(requests, 0);
});

test("every pinned provider is classified with source-backed model and auth metadata", () => {
  const providers = PROVIDER_MODEL_MANIFEST.providers;
  assert.equal(PROVIDER_MODEL_MANIFEST.schemaVersion, 1);
  assert.equal(providers.length, 117);
  assert.equal(PROVIDER_MODEL_MANIFEST.excludedModels.length, 200);
  for (const source of ["omp", "prime"] as const) {
    const roster = PROVIDER_SOURCE_ROSTER[source];
    const modelProviderRoster = PROVIDER_MODEL_PROVIDER_ROSTER[source];
    const sourceManifest = PROVIDER_MODEL_MANIFEST.sources[source];
    assert.equal(sourceManifest.version, PROVIDER_SOURCE_BASELINE[source]);
    assert.deepEqual([...sourceManifest.providerIds].sort(), [...roster].sort());
    assert.deepEqual([...sourceManifest.modelProviderIds].sort(), [...modelProviderRoster].sort());
    assert.deepEqual([...sourceManifest.apiIds].sort(), [...PROVIDER_API_ROSTER[source]].sort());
    const sourceProviders = providers.filter((provider) => provider.source === source);
    assert.deepEqual(
      sourceProviders.map((provider) => provider.providerId).sort(),
      [...modelProviderRoster].sort(),
    );
    assert.equal(
      sourceProviders.filter((provider) => provider.status === "in-scope").length,
      source === "omp" ? 73 : 32,
    );
    assert.equal(
      sourceProviders.reduce((sum, provider) => sum + provider.models.length, 0),
      source === "omp" ? 5480 : 152,
    );
  }

  const miniMaxCn = providers.find((provider) => provider.source === "omp" && provider.providerId === "minimax-cn");
  assert.ok(miniMaxCn?.unlistedModelProvider);
  assert.equal(miniMaxCn?.status, "in-scope");
  assert.deepEqual(miniMaxCn?.authentication.methods, ["api-key"]);
  assert.deepEqual(miniMaxCn?.authentication.envVars, []);

  const keys = new Set<string>();
  for (const provider of providers) {
    assert.ok(provider.providerId.length > 0);
    assert.ok(provider.defaultModel === null || provider.defaultModel.length > 0);
    assert.ok(provider.discovery.source.length > 0);
    assert.ok(provider.authentication.methods.length > 0);
    assert.ok(!provider.authentication.methods.includes("unclassified"), provider.providerId);
    if (provider.status === "excluded") {
      assert.ok(provider.exclusionReason?.length);
      assert.equal(provider.models.length, 0);
      continue;
    }
    assert.equal(provider.status, "in-scope");
    assert.ok(provider.models.length > 0);
    for (const model of provider.models) {
      const key = `${provider.source}:${provider.providerId}:${model.id}`;
      assert.equal(keys.has(key), false, `duplicate model ${key}`);
      keys.add(key);
      assert.ok(model.id.length > 0);
      assert.ok(model.transport.length > 0);
      assert.ok(model.endpoint || model.endpointRule);
      assert.ok(model.capabilities.input.length > 0);
      assert.equal(typeof model.capabilities.reasoning, "boolean");
      assert.ok(model.kind === "chat" || model.kind === "tiny");
      assert.ok(
        PROVIDER_API_ROSTER[provider.source].includes(model.transport as never) ||
          (provider.source === "omp" && model.transport === "local-inference"),
        `${provider.source}:${provider.providerId}/${model.id} has unknown transport ${model.transport}`,
      );
    }
  }
  for (const excluded of PROVIDER_MODEL_MANIFEST.excludedModels) {
    assert.ok(excluded.reason.length > 0);
    assert.ok(excluded.evidence.length > 0);
    assert.ok(excluded.kind !== "chat" && excluded.kind !== "tiny");
  }
});

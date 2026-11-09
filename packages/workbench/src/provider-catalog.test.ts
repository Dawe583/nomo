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
import type { ProviderAdapterConfig } from "./provider-adapters/types.ts";
import { assertProviderDescriptorInManifest, CONFIGURABLE_PROVIDER_DESCRIPTORS, UNAVAILABLE_PROVIDER_MODELS, PROVIDER_API_ROSTER, PROVIDER_MODEL_MANIFEST, PROVIDER_MODEL_PROVIDER_ROSTER, PROVIDER_SOURCE_BASELINE, PROVIDER_SOURCE_ROSTER } from "./provider-catalog.ts";

test("exposes Prime Kimi Coding through its documented Anthropic-compatible API-key endpoint", () => {
  const provider = PROVIDER_MODEL_MANIFEST.providers.find(
    (item) => item.source === "prime" && item.providerId === "kimi-coding",
  );
  assert.ok(provider);
  assert.deepEqual(provider.authentication.methods, ["api-key"]);
  assert.deepEqual(provider.authentication.envVars, ["KIMI_API_KEY"]);
  const model = provider.models.find((item) => item.id === "k3");
  assert.ok(model);
  assert.equal(model.transport, "anthropic-messages");
  assert.equal(model.endpoint, "https://api.kimi.com/coding");
  const descriptor = CONFIGURABLE_PROVIDER_DESCRIPTORS.find(
    (item) => item.providerId === "kimi-coding" && item.transport === "anthropic-messages",
  );
  assert.ok(descriptor);
  assert.equal(descriptor.authKind, "api-key");
  assert.equal(descriptor.endpoint, "https://api.kimi.com/coding");
  assert.deepEqual(descriptor.models, ["k3"]);
  assertProviderDescriptorInManifest({
    providerId: "kimi-coding",
    transport: "anthropic-messages",
    baseUrl: descriptor.endpoint!,
    model: "k3",
    auth: { kind: "api-key", apiKey: "fixture-kimi-coding-key" },
  });
});

test("exposes Kimi Code through its documented OpenAI API-key endpoint", () => {
  const provider = PROVIDER_MODEL_MANIFEST.providers.find(
    (item) => item.source === "omp" && item.providerId === "kimi-code",
  );
  assert.ok(provider);
  const models = provider.models.filter(
    (item) => item.kind === "chat" && item.transport === "openai-completions",
  );
  assert.equal(models.length, 7);
  assert.ok(models.every((item) => item.endpoint === "https://api.kimi.com/coding/v1"));
  assert.ok(provider.authentication.methods.includes("device-code"));
  assert.ok(provider.authentication.methods.includes("api-key"));
  assert.deepEqual(provider.authentication.envVars, ["KIMI_API_KEY"]);
  assert.match(provider.authentication.source, /kimi\.com\/code\/docs/);
  const descriptor = CONFIGURABLE_PROVIDER_DESCRIPTORS.find(
    (item) => item.providerId === "kimi-code" && item.transport === "openai-completions",
  );
  assert.ok(descriptor);
  assert.equal(descriptor.authKind, "api-key");
  assert.equal(descriptor.endpoint, "https://api.kimi.com/coding/v1");
  assert.deepEqual(
    [...descriptor.models].sort(),
    ["k3", "k3-256k", "kimi-for-coding", "kimi-for-coding-highspeed"],
  );
  const unavailable = UNAVAILABLE_PROVIDER_MODELS.find(
    (item) => item.source === "omp" && item.providerId === "kimi-code",
  );
  assert.ok(unavailable);
  assert.deepEqual(
    [...unavailable.modelIds].sort(),
    ["kimi-k2", "kimi-k2-turbo-preview", "kimi-k2.5"],
  );
  assertProviderDescriptorInManifest({
    providerId: "kimi-code",
    transport: "openai-completions",
    baseUrl: descriptor.endpoint!,
    model: "kimi-for-coding",
    auth: { kind: "api-key", apiKey: "fixture-kimi-code-key" },
  });
});

test("exposes Bedrock only through the manifest-declared AWS credential chain", () => {
  const descriptor = CONFIGURABLE_PROVIDER_DESCRIPTORS.find(
    (item) => item.providerId === "amazon-bedrock",
  );
  assert.ok(descriptor);
  assert.equal(descriptor.transport, "bedrock-converse-stream");
  assert.equal(descriptor.authKind, "aws-credential-chain");
  assert.ok(
    CONFIGURABLE_PROVIDER_DESCRIPTORS.filter(
      (item) => item.providerId === "amazon-bedrock",
    ).every(
      (item) =>
        item.transport === "bedrock-converse-stream" &&
        item.authKind === "aws-credential-chain",
    ),
  );
});
test("every pinned OMP Ollama Cloud model has an API-key descriptor", () => {
  const provider = PROVIDER_MODEL_MANIFEST.providers.find(
    (item) =>
      item.source === "omp" &&
      item.providerId === "ollama-cloud" &&
      item.status === "in-scope",
  );
  assert.ok(provider);
  const models = provider.models.filter(
    (model) => model.kind === "chat" && model.transport === "ollama-chat",
  );
  const descriptors = CONFIGURABLE_PROVIDER_DESCRIPTORS.filter(
    (item) =>
      item.providerId === "ollama-cloud" &&
      item.transport === "ollama-chat",
  );

  assert.equal(models.length, 51);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]?.endpoint, "https://ollama.com");
  assert.equal(descriptors[0]?.authKind, "api-key");
  assert.equal(descriptors[0]?.model, provider.defaultModel);
  assert.deepEqual(
    [...(descriptors[0]?.models ?? [])].sort(),
    models.map((model) => model.id).sort(),
  );
});

test("Ollama Cloud configures its selected manifest model without probing tags", async (t) => {
  let requests = 0;
  const { app } = await isolatedWorkbench(
    t,
    async () => {
      requests++;
      throw new Error("Ollama Cloud setup must not probe an undocumented catalog endpoint");
    },
    {},
    { configure: false, prefix: "nomo-ollama-cloud-config-" },
  );

  await app.configure({
    providerId: "ollama-cloud",
    transport: "ollama-chat",
    baseUrl: "https://ollama.com",
    auth: { kind: "api-key", apiKey: "fixture-cloud-secret" },
    model: "gpt-oss:120b",
  });
  const state = await app.providerState();
  assert.equal(state.connected, true);
  assert.equal(state.providerId, "ollama-cloud");
  assert.equal(state.authKind, "api-key");
  assert.equal(state.defaultModel, "gpt-oss:120b");
  assert.equal(JSON.stringify(state).includes("fixture-cloud-secret"), false);
  assert.equal(requests, 0);
});
test("every pinned OMP Bedrock model has a host-chain descriptor", () => {
  const provider = PROVIDER_MODEL_MANIFEST.providers.find(
    (item) =>
      item.source === "omp" &&
      item.providerId === "amazon-bedrock" &&
      item.status === "in-scope",
  );
  assert.ok(provider);
  assert.ok(provider.authentication.methods.includes("native-auth"));
  assert.ok(provider.authentication.methods.includes("host-credential"));
  const models = provider.models.filter(
    (model) =>
      model.kind === "chat" && model.transport === "bedrock-converse-stream",
  );

  assert.equal(models.length, 209);
  const descriptors = CONFIGURABLE_PROVIDER_DESCRIPTORS.filter(
    (item) =>
      item.providerId === "amazon-bedrock" &&
      item.transport === "bedrock-converse-stream" &&
      item.authKind === "aws-credential-chain",
  );
  const missing = models.filter(
    (model) =>
      !descriptors.some(
        (descriptor) =>
          descriptor.endpoint === model.endpoint &&
          descriptor.models.includes(model.id),
      ),
  );
  assert.equal(
    missing.length,
    0,
    `missing Bedrock host-chain descriptors: ${missing.slice(0, 3).map((model) => model.id).join(", ")}`,
  );
});
test("Bedrock Mantle models share the manifest-backed Responses descriptor", () => {
  const provider = PROVIDER_MODEL_MANIFEST.providers.find(
    (item) =>
      item.source === "omp" &&
      item.providerId === "bedrock-mantle" &&
      item.status === "in-scope",
  );
  assert.ok(provider);
  const models = provider.models.filter(
    (model) =>
      model.kind === "chat" && model.transport === "openai-responses",
  );
  const descriptors = CONFIGURABLE_PROVIDER_DESCRIPTORS.filter(
    (item) =>
      item.providerId === "bedrock-mantle" &&
      item.transport === "openai-responses",
  );
  assert.deepEqual(models.map((model) => model.id), [
    "openai.gpt-5.4",
    "openai.gpt-5.5",
    "openai.gpt-5.6-luna",
    "openai.gpt-5.6-sol",
    "openai.gpt-5.6-terra",
  ]);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0]?.endpoint, null);
  assert.equal(descriptors[0]?.endpointRule, "aws-bedrock-mantle");
  assert.equal(descriptors[0]?.authKind, "api-key");
  assert.equal(descriptors[0]?.model, "openai.gpt-5.6-terra");
  assert.deepEqual([...descriptors[0]!.models].sort(), models.map((model) => model.id).sort());

  const valid: ProviderAdapterConfig = {
    providerId: "bedrock-mantle",
    transport: "openai-responses",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
    model: "openai.gpt-5.4",
    auth: { kind: "api-key", apiKey: "fixture-only" },
  };
  assert.doesNotThrow(() => assertProviderDescriptorInManifest(valid));
  for (const baseUrl of [
    "http://bedrock-mantle.us-east-1.api.aws/openai/v1",
    "https://bedrock-mantle.attacker.test/openai/v1",
    "https://bedrock-mantle.us-east-1.api.aws/v1",
    "https://user@bedrock-mantle.us-east-1.api.aws/openai/v1",
    "https://bedrock-mantle.us-east-1.api.aws:444/openai/v1",
    "https://bedrock-mantle.us-east-1.api.aws/openai/v1?redirect=https://attacker.test",
  ]) {
    assert.throws(
      () => assertProviderDescriptorInManifest({ ...valid, baseUrl }),
      /endpoint/,
      baseUrl,
    );
  }
});
test("Cloudflare AI Gateway exposes only manifest-backed endpoint routes", () => {
  const providers = PROVIDER_MODEL_MANIFEST.providers.filter(
    (item) =>
      item.providerId === "cloudflare-ai-gateway" &&
      item.status === "in-scope",
  );
  const models = providers.flatMap((provider) =>
    provider.models.filter((model) => model.kind === "chat"),
  );
  const descriptors = CONFIGURABLE_PROVIDER_DESCRIPTORS.filter(
    (item) => item.providerId === "cloudflare-ai-gateway",
  );
  const routes = {
    "anthropic-messages": "anthropic",
    "openai-completions": "compat",
    "openai-responses": "openai",
  } as const;

  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.transport).sort(),
    Object.keys(routes).sort(),
  );
  for (const descriptor of descriptors) {
    const route = routes[descriptor.transport as keyof typeof routes];
    assert.ok(route);
    assert.equal(descriptor.endpoint, null);
    assert.equal(descriptor.endpointRule, "cloudflare-ai-gateway");
    assert.equal(descriptor.authKind, "api-key");
    assert.deepEqual(
      [...descriptor.models].sort(),
      [...new Set(
        models
          .filter((model) => model.transport === descriptor.transport)
          .map((model) => model.id),
      )].sort(),
    );

    const config: ProviderAdapterConfig = {
      providerId: descriptor.providerId,
      transport: descriptor.transport,
      baseUrl: `https://gateway.ai.cloudflare.com/v1/account-id/default/${route}`,
      model: descriptor.model,
      auth: { kind: "api-key", apiKey: "fixture-only" },
    };
    assert.doesNotThrow(() => assertProviderDescriptorInManifest(config));
    for (const baseUrl of [
      `https://gateway.ai.cloudflare.com/v1/account-id/default/wrong`,
      `https://gateway.ai.cloudflare.attacker.test/v1/account-id/default/${route}`,
      `http://gateway.ai.cloudflare.com/v1/account-id/default/${route}`,
      `https://gateway.ai.cloudflare.com:444/v1/account-id/default/${route}`,
      `https://gateway.ai.cloudflare.com/v1/account-id%2Fother/default/${route}`,
      `https://gateway.ai.cloudflare.com/v1/account-id/default/${route}?next=https://attacker.test`,
    ]) {
      assert.throws(
        () => assertProviderDescriptorInManifest({ ...config, baseUrl }),
        /endpoint/,
        baseUrl,
      );
    }
  }
  assert.ok(models.length > 0);
  assert.throws(
    () =>
      assertProviderDescriptorInManifest({
        providerId: "cloudflare-ai-gateway",
        transport: "anthropic-messages",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account-id/default/anthropic",
        model: descriptors.find((item) => item.transport === "anthropic-messages")!.model,
        auth: { kind: "none" },
      }),
    /requires api-key authentication/,
  );
});
test("Cloudflare AI Gateway configures each pinned route without catalog probes", async (t) => {
  let requests = 0;
  const { app } = await isolatedWorkbench(
    t,
    async () => {
      requests++;
      throw new Error("Cloudflare setup must not probe a provider catalog");
    },
    {},
    { configure: false, prefix: "nomo-cloudflare-gateway-config-" },
  );
  const routes = {
    "anthropic-messages": "anthropic",
    "openai-completions": "compat",
    "openai-responses": "openai",
  } as const;

  for (const descriptor of CONFIGURABLE_PROVIDER_DESCRIPTORS.filter(
    (item) => item.providerId === "cloudflare-ai-gateway",
  )) {
    const route = routes[descriptor.transport as keyof typeof routes];
    assert.ok(route);
    await app.configure({
      providerId: descriptor.providerId,
      transport: descriptor.transport,
      baseUrl: `https://gateway.ai.cloudflare.com/v1/account-id/default/${route}`,
      auth: { kind: "api-key", apiKey: "fixture-cloudflare-token" },
      model: descriptor.model,
    });
    const state = await app.providerState();
    assert.equal(state.connected, true);
    assert.equal(state.providerId, descriptor.providerId);
    assert.equal(state.transport, descriptor.transport);
    assert.equal(state.defaultModel, descriptor.model);
  }
  assert.equal(requests, 0);
});

test("every implemented chat model is either described or explicitly blocked", async (t) => {
  let requests = 0;
  const { app } = await isolatedWorkbench(
    t,
    async () => {
      requests++;
      throw new Error("provider availability must not make requests");
    },
    {},
    { configure: false, prefix: "nomo-provider-model-coverage-" },
  );
  const state = await app.providerState();
  const unavailable = Reflect.get(
    state,
    "unavailableProviderModels",
  ) as Array<{
    source: string;
    providerId: string;
    transportId: string;
    status: string;
    modelIds: string[];
    reason: string;
    evidence: string;
    disabled: boolean;
  }> | undefined;
  assert.ok(Array.isArray(unavailable), "provider state must expose blocked model rows");

  const implemented = new Set(
    PROVIDER_MODEL_MANIFEST.apiTransports
      .filter((api) => api.status === "implemented")
      .map((api) => api.apiId),
  );
  const modelRows = new Set<string>();
  const missing: string[] = [];
  for (const provider of PROVIDER_MODEL_MANIFEST.providers) {
    if (provider.status !== "in-scope") continue;
    for (const model of provider.models) {
      if (model.kind !== "chat" || !implemented.has(model.transport)) continue;
      const key = JSON.stringify([
        provider.source,
        provider.providerId,
        model.transport,
        model.id,
      ]);
      modelRows.add(key);
      const vertexDynamic =
        model.transport === "google-vertex" &&
        model.endpoint === "https://{location}-aiplatform.googleapis.com";
      const bedrockMantleDynamic =
        provider.providerId === "bedrock-mantle" &&
        model.transport === "openai-responses" &&
        model.endpoint === "https://bedrock-mantle.{region}.api.aws/openai/v1";
      const cloudflareRoute =
        model.transport === "anthropic-messages" ? "anthropic"
          : model.transport === "openai-completions" ? "compat"
          : model.transport === "openai-responses" ? "openai"
          : null;
      const cloudflareDynamic =
        provider.providerId === "cloudflare-ai-gateway" &&
        cloudflareRoute !== null &&
        (model.endpoint === `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/${cloudflareRoute}` ||
          model.endpoint === `https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/${cloudflareRoute}`);
      const cloudflareWorkersAiDynamic =
        provider.providerId === "cloudflare-workers-ai" &&
        model.transport === "openai-completions" &&
        model.endpoint === "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";
      const endpoint =
        vertexDynamic || bedrockMantleDynamic || cloudflareDynamic || cloudflareWorkersAiDynamic
          ? null
          : model.endpoint;
      const endpointRule = vertexDynamic
        ? "google-vertex-standard"
        : bedrockMantleDynamic
          ? "aws-bedrock-mantle"
          : cloudflareDynamic
            ? "cloudflare-ai-gateway"
            : cloudflareWorkersAiDynamic
              ? "cloudflare-workers-ai"
              : model.endpointRule;
      const descriptorMatches = CONFIGURABLE_PROVIDER_DESCRIPTORS.filter(
        (descriptor) =>
          descriptor.providerId === provider.providerId &&
          descriptor.transport === model.transport &&
          descriptor.endpoint === endpoint &&
          descriptor.endpointRule === endpointRule &&
          descriptor.models.includes(model.id),
      ).length;
      const blockerMatches = unavailable.filter(
        (blocker) =>
          blocker.source === provider.source &&
          blocker.providerId === provider.providerId &&
          blocker.transportId === model.transport &&
          blocker.modelIds.includes(model.id),
      ).length;
      if (descriptorMatches + blockerMatches !== 1)
        missing.push(`${provider.source}:${provider.providerId}/${model.id}`);
    }
  }
  const blockedRows = unavailable.flatMap((blocker) =>
    blocker.modelIds.map((modelId) =>
      JSON.stringify([
        blocker.source,
        blocker.providerId,
        blocker.transportId,
        modelId,
      ]),
    ),
  );
  assert.equal(unavailable.length, 4);
  assert.equal(blockedRows.length, 28);
  assert.equal(new Set(blockedRows).size, blockedRows.length);
  assert.ok(blockedRows.every((row) => modelRows.has(row)));
  assert.ok(
    unavailable.every(
      (blocker) =>
        blocker.status === "blocked" &&
        blocker.disabled &&
        blocker.reason.length > 0 &&
        blocker.evidence.length > 0,
    ),
  );
  assert.equal(
    missing.length,
    0,
    `unclassified provider models: ${missing.slice(0, 8).join(", ")}`,
  );
  assert.equal(requests, 0);
});


test("a provider that answers 404 for its catalog accepts the model the operator named", async (t) => {
  const fetcher: typeof fetch = async () => new Response("no catalog", { status: 404 });
  const { app } = await isolatedWorkbench(t, fetcher, {}, {
    configure: false,
    prefix: "nomo-catalog-404-",
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
    prefix: "nomo-catalog-404-unnamed-",
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
    prefix: "nomo-catalog-401-",
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
    prefix: "nomo-catalog-empty-",
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
    prefix: "nomo-catalog-listed-",
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
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  };
  const { app } = await isolatedWorkbench(
    t,
    fetcher,
    { DASHSCOPE_API_KEY: "dashscope-fixture-key" },
    { configure: false, prefix: "nomo-dashscope-catalog-" },
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
      : Response.json({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  const { app } = await isolatedWorkbench(
    t,
    fetcher,
    { DASHSCOPE_API_KEY: "dashscope-fixture-key" },
    { configure: false, prefix: "nomo-dashscope-404-" },
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
    "gitlab-duo-agent", "google-gemini-cli", "openai-codex-responses",
  ]);
  assert.deepEqual(BLOCKED_PROVIDER_APIS_BY_PROVIDER, {
    "google-gemini-cli": "google-gemini-cli",
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
  }, {}, { configure: false, prefix: "nomo-provider-api-blockers-" });
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

test("provider state explicitly blocks local tiny models without probing", async (t) => {
  let requests = 0;
  const { app } = await isolatedWorkbench(t, async () => {
    requests++;
    throw new Error("blocked model transports must not make requests");
  }, {}, { configure: false, prefix: "nomo-provider-model-transport-blockers-" });
  const state = await app.providerState();
  assert.equal(
    CONFIGURABLE_PROVIDER_DESCRIPTORS.some(({ providerId }) => providerId === "local"),
    false,
  );
  const unavailable = Reflect.get(state, "unavailableModelTransports") as Array<{
    source: string;
    providerId: string;
    transportId: string;
    status: string;
    reason: string;
    evidence: string;
    modelIds: string[];
    disabled: boolean;
  }>;
  assert.deepEqual(
    unavailable.map(({ source, providerId, transportId, status, modelIds, disabled }) =>
      [source, providerId, transportId, status, modelIds, disabled],
    ),
    [[
      "omp",
      "local",
      "local-inference",
      "blocked",
      [
        "falcon-h1-90m",
        "gemma-3-1b",
        "lfm2-1.2b",
        "lfm2.5-230m",
        "lfm2.5-350m",
        "llama3.2:3b",
        "qwen2.5-1.5b",
        "qwen3-1.7b",
      ],
      true,
    ]],
  );
  assert.match(unavailable[0].reason, /dependency-free.*ONNX\/MLX worker.*downloaded model weights/i);
  assert.match(unavailable[0].evidence, /local-models\.md/);
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

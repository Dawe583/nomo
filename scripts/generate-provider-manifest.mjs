#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { IMPLEMENTED_PROVIDER_TRANSPORTS, PROVIDER_API_BLOCKERS } from "../packages/workbench/src/provider-adapters/types.ts";


const [ompRoot, primeRoot, outputArg = "packages/workbench/src/provider-manifest.json"] = process.argv.slice(2);
if (!ompRoot || !primeRoot) {
  console.error("Usage: node scripts/generate-provider-manifest.mjs <omp-root> <prime-root> [output]");
  process.exit(2);
}
const read = (path) => readFileSync(resolve(path), "utf8");
const json = (path) => JSON.parse(read(path));
const decodeRustString = (value) => JSON.parse(`"${value}"`);
const sort = (values) => values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const ompVersion = json(`${ompRoot}/packages/coding-agent/package.json`).version;
if (ompVersion !== "18.6.2") throw new Error(`Expected OMP 18.6.2, found ${ompVersion}`);
const primeCargo = read(`${primeRoot}/Cargo.toml`);
const primeVersionMatch = primeCargo.match(/\[workspace\.package\][\s\S]*?\bversion\s*=\s*"([^"]+)"/);
if (!primeVersionMatch) throw new Error("Could not parse Prime workspace package version");
const primeVersion = primeVersionMatch[1];
if (primeVersion !== "0.10.1") throw new Error(`Expected Prime 0.10.1, found ${primeVersion}`);
const ompProviderSource = read(`${ompRoot}/packages/catalog/src/compat/provider-ids.ts`);
const ompApiSource = read(`${ompRoot}/packages/catalog/src/types.ts`);
const primeApiSource = read(`${primeRoot}/crates/pa-types/src/ai/mod.rs`);
const primeModelSource = read(`${primeRoot}/crates/pa-ai/src/models_generated.rs`);
const ompKnownProviderIds = sort([...ompProviderSource.matchAll(/^\s*\|\s*"([^"]+)"/gm)].map((match) => match[1]));
const ompApiSection = ompApiSource.match(/export type KnownApi\s*=([\s\S]*?)\nexport type Api/);
if (!ompApiSection) throw new Error("Could not parse OMP KnownApi enum");
const ompApiIds = sort([...ompApiSection[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
const primeApiSection = primeApiSource.match(/pub enum KnownApi\s*\{([\s\S]*?)\n\}/);
if (!primeApiSection) throw new Error("Could not parse Prime KnownApi enum");
const primeApiIds = sort([...primeApiSection[1].matchAll(/^\s*([A-Z][A-Za-z0-9]+),?\s*$/gm)].map((match) =>
  match[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(),
));

const ompModels = json(`${ompRoot}/packages/catalog/src/models.json`);
const ompRules = json(`${ompRoot}/packages/catalog/src/compat/rules.json`);
const authProviders = ompRules.auth?.providers ?? [];
const ompProviderRows = new Map();
const ompSeenRows = new Set();
const excludedModels = [];
const nonChatKindByApi = new Map([
  ["openai-images", "image"],
  ["openrouter-images", "image"],
  ["xai-tts", "tts"],
  ["openai-speech", "tts"],
  ["openai-transcriptions", "stt"],
  ["openai-embeddings", "embedding"],
  ["openrouter-rerank", "rerank"],
  ["openrouter-video", "video"],
  ["openrouter-decisions", "judge"],
  ["typesafe", "judge"],
  ["web-search", "search"],
]);
const modelKind = (providerId, row) => {
  if (row.kind !== undefined) return row.kind;
  if (ompApiIds.includes(row.api)) return "chat";
  const inferred = nonChatKindByApi.get(row.api);
  if (inferred) return inferred;
  throw new Error(`Model kind is absent and transport has no source-backed classification: ${providerId}/${row.id}/${row.api}`);
};
const addOmpModel = (providerId, row, origin) => {
  if (typeof row.id !== "string" || typeof row.api !== "string") throw new Error(`Invalid OMP model row: ${providerId}`);
  const key = `${providerId}\u0000${row.id}\u0000${row.api}`;
  if (ompSeenRows.has(key)) return;
  ompSeenRows.add(key);
  const kind = modelKind(providerId, row);
  if (kind !== "chat" && kind !== "tiny") {
    excludedModels.push({ source: "omp", providerId, modelId: row.id, kind, transport: row.api, reason: `Out-of-scope model kind: ${kind}`, evidence: origin });
    return;
  }
  const providerRows = ompProviderRows.get(providerId) ?? new Map();
  const modelKey = `${row.id}\u0000${row.api}`;
  providerRows.set(modelKey, { row, origin });
  ompProviderRows.set(providerId, providerRows);
};
for (const [providerId, rows] of Object.entries(ompModels)) {
  for (const row of Object.values(rows)) addOmpModel(providerId, row, "catalog/models.json");
}
for (const [providerId, descriptor] of Object.entries(ompRules.providers)) {
  for (const row of descriptor.seed?.models ?? []) addOmpModel(providerId, row, `compat/rules.json:providers.${providerId}.seed`);
}

const primeString = String.raw`"((?:\\.|[^"\\])*)"`;
const primeRowPattern = new RegExp(`RawModel\\s*\\{\\s*provider:\\s*${primeString},\\s*id:\\s*${primeString},\\s*name:\\s*${primeString},\\s*api:\\s*${primeString},\\s*base_url:\\s*${primeString}`, "g");
const primeRows = new Map();
for (const match of primeModelSource.matchAll(primeRowPattern)) {
  const [, providerRaw, idRaw, nameRaw, apiRaw, endpointRaw] = match;
  const providerId = decodeRustString(providerRaw);
  const id = decodeRustString(idRaw);
  const start = match.index;
  const end = primeModelSource.indexOf("\n    },", start);
  if (end < 0) throw new Error(`Unterminated Prime model row ${providerId}/${id}`);
  const block = primeModelSource.slice(start, end);
  const inputMatch = block.match(/input:\s*&\[([^\]]*)\]/);
  const inputs = inputMatch ? [...inputMatch[1].matchAll(/ModelInput::([A-Za-z]+)/g)].map((item) => item[1].toLowerCase()) : [];
  const reasoning = block.match(/reasoning:\s*(true|false)/)?.[1] === "true";
  const contextWindow = Number(block.match(/context_window:\s*([\d_]+)/)?.[1]?.replaceAll("_", "") ?? 0) || null;
  const maxTokens = Number(block.match(/max_tokens:\s*([\d_]+)/)?.[1]?.replaceAll("_", "") ?? 0) || null;
  const model = {
    id,
    name: decodeRustString(nameRaw),
    kind: "chat",
    transport: decodeRustString(apiRaw),
    endpoint: decodeRustString(endpointRaw) || null,
    endpointRule: decodeRustString(endpointRaw) ? null : "Provider configuration supplies the endpoint; Prime compiled row leaves base_url empty.",
    capabilities: { input: inputs, reasoning, tools: null, contextWindow, maxTokens },
    evidence: "crates/pa-ai/src/models_generated.rs:RawModel",
  };
  const rows = primeRows.get(providerId) ?? new Map();
  const key = `${id}\u0000${model.transport}`;
  if (rows.has(key)) throw new Error(`Duplicate Prime model row ${providerId}/${id}/${model.transport}`);
  rows.set(key, model);
  primeRows.set(providerId, rows);
}
if (primeRows.size === 0) throw new Error("No Prime compiled model rows parsed");

const ompAuthMethod = (providerId, descriptor, auth) => {
  const methods = [];
  if (auth?.login?.kind) methods.push(auth.login.kind);
  if (auth?.nativeAuthApis?.length) methods.push("native-auth");
  if (auth?.env?.hook) methods.push("host-credential");
  if (descriptor?.envVars?.length && !methods.includes("api-key")) methods.push("api-key");
  if (auth?.allowsMissingApiKey || auth?.login?.emptyFallback !== undefined || descriptor?.allowUnauthenticated) methods.push("optional-api-key");
  if (providerId === "local" && methods.length === 0) methods.push("user-managed-local-runtime");
  if (methods.length === 0) methods.push("unclassified");
  return methods;
};
const primeEnvSource = read(`${primeRoot}/crates/pa-ai/src/env_api_keys.rs`);
const primeEnvByProvider = new Map();
for (const match of primeEnvSource.matchAll(/"([a-z0-9-]+)"\s*=>\s*Some\(vec!\[([^\]]*)\]\)/g)) {
  const envVars = [...match[2].matchAll(/"([A-Z0-9_]+)"/g)].map((item) => item[1]);
  primeEnvByProvider.set(match[1], envVars);
}
for (const match of primeEnvSource.matchAll(/"([a-z0-9-]+)"(?:\s*\|\s*"([a-z0-9-]+)")*\s*=>\s*"([A-Z0-9_]+)"/g)) {
  for (const id of match.slice(1, -1).filter(Boolean)) primeEnvByProvider.set(id, [match.at(-1)]);
}
const primeAuth = (providerId) => {
  const methods = [];
  const envVars = primeEnvByProvider.get(providerId) ?? [];
  if (envVars.length) methods.push("api-key");
  if (providerId === "anthropic") methods.push("oauth-token");
  if (providerId === "amazon-bedrock") methods.push("aws-credential-chain");
  if (providerId === "google-vertex") methods.push("google-application-default-credentials");
  if (providerId === "github-copilot") methods.push("oauth-token");
  if (providerId === "openai-codex") methods.push("subscription-oauth");
  return {
    source: providerId === "openai-codex" ? "crates/pa-cli/src/codex_subscription_login.rs" : "crates/pa-ai/src/env_api_keys.rs",
    methods: methods.length ? methods : ["unclassified"],
    envVars,
  };
};

const endpointRuleFor = (api) => {
  if (api === "azure-openai-responses") return "Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME; resource names resolve to https://{resource}.openai.azure.com/openai/v1; POST /responses?api-version={configured version (default v1)}.";
  if (api === "apple-foundation-models") return "On-device Apple Foundation Models; runtime endpoint is platform-provided.";
  if (api === "local-inference") return "User-managed local inference runtime; endpoint is operator-configured.";
  return "Provider endpoint is supplied by provider configuration; source model row has no base URL.";
};
const modelRecord = (row, origin) => ({
  id: row.id,
  name: row.name ?? row.id,
  kind: row.kind ?? "chat",
  transport: row.api,
  endpoint: typeof row.baseUrl === "string" && row.baseUrl ? row.baseUrl : null,
  endpointRule: typeof row.baseUrl === "string" && row.baseUrl ? null : endpointRuleFor(row.api),
  capabilities: {
    input: Array.isArray(row.input) ? row.input : [],
    reasoning: row.reasoning === true,
    tools: typeof row.compat?.supportsToolChoice === "boolean" ? row.compat.supportsToolChoice : null,
    contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : null,
    maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : null,
  },
  evidence: origin,
});
const providers = [];
const ompModelProviderIds = sort([...new Set([...ompKnownProviderIds, ...ompProviderRows.keys()])]);
for (const providerId of ompModelProviderIds) {
  const descriptor = ompRules.providers[providerId];
  const auth = authProviders.find((item) => item.id === providerId);
  const unlistedModelProvider = !ompKnownProviderIds.includes(providerId);
  if (unlistedModelProvider && providerId !== "minimax-cn") {
    throw new Error(`OMP model provider needs explicit source classification: ${providerId}`);
  }
  if (!descriptor && !unlistedModelProvider) throw new Error(`OMP provider missing compiled rules: ${providerId}`);
  const models = [...(ompProviderRows.get(providerId)?.values() ?? [])].map(({ row, origin }) => modelRecord(row, origin));
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.transport < b.transport ? -1 : a.transport > b.transport ? 1 : 0));
  const included = models.length > 0;
  const exclusionReason = providerId === "apple"
    ? "Apple Foundation Models is dynamically discovered through the native pi-natives bridge; this Workbench build does not link that bridge. Upstream availability requires a built bridge, macOS 27+, and an Apple Intelligence-eligible device."
    : "Pinned OMP model catalog and provider seeds contain no chat/tiny model row for this provider.";

  providers.push({
    source: "omp",
    providerId,
    ...(unlistedModelProvider ? { unlistedModelProvider: true } : {}),
    status: included ? "in-scope" : "excluded",
    ...(included ? {} : { exclusionReason }),
    defaultModel: descriptor?.defaultModel ?? null,
    discovery: {
      source: unlistedModelProvider ? "packages/catalog/src/provider-models/openai-compat.ts" : "packages/catalog/src/compat/rules.json",
      mode: unlistedModelProvider ? "compiled-provider-descriptor" : descriptor.dynamicModelsAuthoritative ? "dynamic-authoritative" : descriptor.discovery ? "provider-discovery" : "bundled-or-operator-configured",
      descriptor: descriptor?.discovery?.label ?? null,
    },
    authentication: {
      source: unlistedModelProvider ? "packages/catalog/src/provider-models/openai-compat.ts; packages/ai/src/providers/anthropic.ts" : auth ? "packages/catalog/src/compat/rules.json:auth.providers" : "provider rules envVars",
      methods: unlistedModelProvider ? ["api-key"] : ompAuthMethod(providerId, descriptor, auth),
      envVars: descriptor?.envVars ?? auth?.env?.vars ?? [],
      nativeAuthApis: auth?.nativeAuthApis ?? [],
    },
    models,
  });
}
for (const providerId of sort([...primeRows.keys()])) {
  const models = [...primeRows.get(providerId).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const authentication = primeAuth(providerId);
  providers.push({
    source: "prime",
    providerId,
    status: models.length ? "in-scope" : "excluded",
    ...(models.length ? {} : { exclusionReason: "No compiled Prime chat model row exists for this provider." }),
    defaultModel: null,
    discovery: { source: "crates/pa-ai/src/models_generated.rs", mode: "compiled-fallback", descriptor: null },
    authentication,
    models,
  });
}
const implementedTransportFiles = {
  "openai-completions": "packages/workbench/src/provider-adapters/openai-completions.ts",
  "openai-responses": "packages/workbench/src/provider-adapters/openai-responses.ts",
  "azure-openai-responses": "packages/workbench/src/provider-adapters/openai-responses.ts",
  "anthropic-messages": "packages/workbench/src/provider-adapters/anthropic-messages.ts",
  "google-generative-ai": "packages/workbench/src/provider-adapters/google-generative-ai.ts",
  "google-vertex": "packages/workbench/src/provider-adapters/google-generative-ai.ts",
  "bedrock-converse-stream": "packages/workbench/src/provider-adapters/bedrock-converse-stream.ts",
  "mistral-conversations": "packages/workbench/src/provider-adapters/mistral-conversations.ts",
  "ollama-chat": "packages/workbench/src/provider-adapters/ollama-chat.ts",
  openrouter: "packages/workbench/src/provider-adapters/gateways.ts",
};
const implementedTransportSet = new Set(IMPLEMENTED_PROVIDER_TRANSPORTS);
const apiTransports = [];
for (const [source, apiIds] of [["omp", ompApiIds], ["prime", primeApiIds]]) {
  for (const apiId of apiIds) {
    const blocker = PROVIDER_API_BLOCKERS[apiId];
    const implemented = implementedTransportSet.has(apiId);
    apiTransports.push({
      source,
      apiId,
      name: blocker?.name ?? apiId,
      status: blocker?.status ?? (implemented ? "implemented" : "blocked"),
      reason: blocker?.reason ?? (implemented
        ? "Workbench has a registered adapter for this API transport."
        : "Workbench has no adapter for this source API ID."),
      evidence: blocker?.evidence ?? (implemented
        ? `packages/workbench/src/provider-adapters/factory.ts; ${implementedTransportFiles[apiId]}`
        : "packages/workbench/src/provider-adapters/types.ts; packages/workbench/src/provider-adapters/factory.ts"),
    });
  }
}




const manifest = {
  schemaVersion: 1,
  apiTransports,
  sources: {
    omp: { version: ompVersion, providerIds: ompKnownProviderIds, modelProviderIds: ompModelProviderIds, apiIds: ompApiIds },
    prime: { version: primeVersion, providerIds: sort([...primeRows.keys()]), modelProviderIds: sort([...primeRows.keys()]), apiIds: primeApiIds },
  },
  providers,
  excludedModels: excludedModels.sort((a, b) => a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0),
};
const outputPath = resolve(outputArg);
writeFileSync(outputPath, `${JSON.stringify(manifest)}\n`, { flag: "w" });
console.log(JSON.stringify({ output: outputPath, ompKnownProviders: ompKnownProviderIds.length, ompModelProviders: ompModelProviderIds.length, ompChatTinyRows: [...ompProviderRows.values()].reduce((sum, rows) => sum + rows.size, 0), primeProviders: primeRows.size, primeRows: [...primeRows.values()].reduce((sum, rows) => sum + rows.size, 0), excludedNonChatRows: excludedModels.length }));

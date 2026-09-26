import { getVercelOidcToken } from "@vercel/oidc";
import { createHash } from "node:crypto";
import { CompatibleProvider, normalizeProviderConfig, ProviderRequestError } from "../packages/workbench/src/provider.ts";
import { providerStateFromFailure } from "../packages/workbench/src/gui.ts";
import {
  NVIDIA_URL,
  TOKENROUTER_URL,
  PROVIDER_PRESETS,
} from "../packages/workbench/src/provider-defaults.ts";
import { read, write, encrypt, decrypt } from "./store.mjs";
import { assertOwner } from "./owner.mjs";

// Every `read` and `write` here, injected or not, takes the owner first, so no
// path through this module can reach a provider row without one. A test that
// injects its own pair is handed the owner rather than trusted with choosing it.
const dependencies = (overrides) => ({
  read, write, encrypt, decrypt, env: process.env, fetch,
  oidc: getVercelOidcToken, ...overrides,
});

// A workspace with nothing saved hashes as null, which keeps the absence out of
// the provider-mode vocabulary instead of inventing a vendor to stand for it.
const snapshotKey = snapshot => createHash("sha256")
  .update(JSON.stringify(snapshot ?? null)).digest("hex");

export async function rememberProviderFailure(owner, snapshot, failure, client, overrides) {
  const deps = dependencies(overrides);
  await deps.write(owner, "provider-failure", {
    provider: snapshotKey(snapshot), status: failure.status,
    retryAt: failure.retryAfter === undefined ? null : new Date(Date.now() + failure.retryAfter * 1000).toISOString(),
  }, client);
}

async function configuration(config, deps) {
  if (config?.disabled) return null;
  if (config?.secret) return normalizeProviderConfig(deps.decrypt(config.secret));
  // Explicit snapshots keep the provider that originally received the session.
  if (config?.mode === "gateway")
    return {
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      apiKey: deps.env.AI_GATEWAY_API_KEY ?? (await deps.oidc()),
      kind: "compatible",
    };
  if (config?.mode === "tokenrouter") {
    if (!deps.env.TOKENROUTER_API_KEY) return null;
    return { baseUrl: TOKENROUTER_URL, apiKey: deps.env.TOKENROUTER_API_KEY, kind: "compatible" };
  }
  if (config?.mode && config.mode !== "nvidia")
    throw new Error("The saved provider is unavailable. Reconnect it explicitly.");
  if (!deps.env.NVIDIA_API_KEY) return null;
  return { baseUrl: NVIDIA_URL, apiKey: deps.env.NVIDIA_API_KEY, kind: "compatible" };
}

export async function provider(owner, snapshot, overrides) {
  const deps = dependencies(overrides);
  const config = await configuration(snapshot ?? (await deps.read(owner, "provider")), deps);
  if (!config) throw new Error("Connect the saved provider or configure NVIDIA_API_KEY for NVIDIA NIM.");
  return new CompatibleProvider(config, deps.fetch);
}

export async function providerState(owner, overrides) {
  const deps = dependencies(overrides);
  let credentials = Boolean(deps.env.NVIDIA_API_KEY);
  // No provider and no model until one is configured. The presets are the
  // choices on offer, never the one the deployment answered for the operator.
  const defaults = {
    defaultModel: null,
    providerId: null,
    baseUrl: null,
    presets: PROVIDER_PRESETS.filter((p) => !("local" in p)),
    keyStorage: "encrypted-cloud",
    profiles: [],
    models: [],
    connected: false,
    setupRequired: false,
  };
  try {
    const saved = await deps.read(owner, "provider");
    if (saved?.secret) {
      credentials = true;
      const raw = deps.decrypt(saved.secret), normalized = normalizeProviderConfig(raw);
      if (raw.kind !== normalized.kind) {
        const secret = deps.encrypt(normalized), profiles = (await deps.read(owner, "provider-profiles")) ?? {};
        await deps.write(owner, "provider", { ...saved, secret });
        if (profiles[normalized.baseUrl]) {
          profiles[normalized.baseUrl] = secret;
          await deps.write(owner, "provider-profiles", profiles);
        }
      }
    }
    const config = await configuration(saved, deps);
    credentials = config !== null;
    if (!config) return { ...defaults, setupRequired: true, ...providerStateFromFailure(false, null, false) };
    Object.assign(defaults, {
      baseUrl: config.baseUrl,
      kind: config.kind,
      providerId: PROVIDER_PRESETS.find((p) => p.baseUrl === config.baseUrl)?.id ?? "custom",
    });
    const models = await new CompatibleProvider(config, deps.fetch).models();
    const failure = await deps.read(owner, "provider-failure");
    const observed = failure?.status && failure.provider === snapshotKey(saved) ? failure : null;
    return {
      ...defaults,
      connected: true,
      models,
      profiles: Object.keys((await deps.read(owner, "provider-profiles")) ?? {}),
      mode: defaults.providerId,
      ...providerStateFromFailure(true, observed, true),
    };
  } catch (error) {
    // Configuration, database and transport errors are not safe public strings.
    const failure = error instanceof ProviderRequestError
      ? { status: error.status, retryAfter: error.retryAfter }
      : { status: 503 };
    return { ...defaults, ...providerStateFromFailure(false, failure, credentials) };
  }
}

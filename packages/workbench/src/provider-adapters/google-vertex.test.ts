import test from "node:test";
import assert from "node:assert/strict";
import { createProviderClient } from "./factory.ts";
import type { ProviderAdapterConfig } from "./types.ts";
import { PROVIDER_API_BLOCKERS } from "./types.ts";
import { PROVIDER_MODEL_MANIFEST } from "../provider-catalog.ts";

const unavailable = PROVIDER_API_BLOCKERS["google-vertex"];
const neverRequest: typeof fetch = async () => {
  throw new Error("Blocked Vertex configuration must not issue a request.");
};

test("Google Vertex API ID fails closed with its source-backed endpoint-config blocker", () => {
  const typed: ProviderAdapterConfig = {
    providerId: "google-vertex",
    transport: "google-vertex",
    baseUrl: "https://aiplatform.googleapis.com",
    auth: { kind: "api-key", apiKey: "fixture-only" },
  };
  const message = `Provider API google-vertex is unavailable: ${unavailable.reason}`;
  assert.throws(() => createProviderClient(typed, neverRequest), error =>
    error instanceof Error && error.message === message,
  );
});

test("Google Vertex identity cannot fall through to generic Chat Completions", () => {
  const typed: ProviderAdapterConfig = {
    providerId: "google-vertex",
    transport: "openai-completions",
    baseUrl: "https://aiplatform.googleapis.com/v1",
    auth: { kind: "api-key", apiKey: "fixture-only" },
  };
  assert.throws(() => createProviderClient(typed, neverRequest), error =>
    error instanceof Error && error.message === `Provider API google-vertex is unavailable: ${unavailable.reason}`,
  );
  assert.throws(() => createProviderClient({
    providerId: "google-vertex",
    api: "openai-completions",
    baseUrl: "https://aiplatform.googleapis.com/v1",
    apiKey: "fixture-only",
  }, neverRequest), error =>
    error instanceof Error && error.message === `Provider API google-vertex is unavailable: ${unavailable.reason}`,
  );
});

test("the manifest blocks both pinned Vertex API roster rows with a specific reason", () => {
  const rows = PROVIDER_MODEL_MANIFEST.apiTransports.filter(row => row.apiId === "google-vertex");
  assert.deepEqual(rows.map(row => row.source), ["omp", "prime"]);
  assert.ok(rows.every(row => row.status === "blocked" && row.reason === unavailable.reason));
  assert.ok(unavailable.reason.includes("project, or location"));
  assert.ok(unavailable.evidence.includes("express-mode/api-reference"));
});

import assert from "node:assert/strict";
import test from "node:test";

import { appwriteManifest, provisionAppwrite, readProvisionConfig } from "./appwrite.mjs";

const config = {
  endpoint: "https://cloud.appwrite.io/v1",
  projectId: "project",
  provisionKey: "admin-key",
  databaseId: "void_control_plane",
  webOrigins: ["https://void-tui.vercel.app", "http://localhost"],
};

const body = (value, status = 200) => new Response(JSON.stringify(value), { status });

function actualBucket(bucket = appwriteManifest.bucket) {
  return { $id: bucket.bucketId, name: bucket.name, $permissions: bucket.permissions, fileSecurity: bucket.fileSecurity, enabled: bucket.enabled };
}

function actualPlatform(platform) {
  return { $id: platform.platformId, name: platform.name, hostname: platform.hostname };
}

function actualFunction(fn = appwriteManifest.function) {
  return {
    $id: fn.functionId,
    name: fn.name,
    runtime: fn.runtime,
    entrypoint: fn.entrypoint,
    commands: fn.commands,
    timeout: fn.timeout,
    execute: fn.execute,
    scopes: fn.scopes,
    vars: fn.variables.map((key) => ({ key, value: "", secret: true })),
    deploymentId: "deployment-0000000000000000",
  };
}

function expected(path, options = {}) {
  path = String(path);
  if (path.includes("/tablesdb/")) return { $id: "void_control_plane" };
  if (path.includes("void_documents")) return actualBucket();
  if (path.endsWith("/domains")) return { total: options.domains?.length ?? 0, domains: options.domains ?? [] };
  const platform = appwriteManifest.platforms.find((entry) => path.endsWith(`/${entry.platformId}`));
  if (platform) return actualPlatform(platform);
  if (path.endsWith(`/${appwriteManifest.function.functionId}`)) return actualFunction(options.function ?? appwriteManifest.function);
  return {};
}

/** A fetcher for a project that has no hosted MCP function yet. */
function createFetcher(calls, options = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const path = String(url);
    if (init.method === "POST" && path.endsWith("/functions")) return body({ ...actualFunction(), vars: [] }, 201);
    if (init.method === "GET") return body(expected(path, options), 200);
    return body(expected(path, options), 201);
  };
}

/** A fetcher for a project that already has a hosted MCP function. */
function existingFetcher(calls, options = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const path = String(url);
    if (init.method === "POST") return body({}, 409);
    if (path.endsWith("/domains") && options.status) return body({}, options.status);
    return body(expected(path, options), 200);
  };
}

test("provisioner uses the live control plane resource IDs and permits only exact local development", async () => {
  const calls = [];
  const fetcher = createFetcher(calls);

  const result = await provisionAppwrite(config, fetcher);

  assert.deepEqual(result, { databaseId: "void_control_plane", bucketId: "void_documents", platforms: ["void_web", "void_local_web"], hostedMcp: { functionId: "6abbae3e000f6f24ce2a", url: null, needsDomain: true, reason: "The function has no registered public domain. Add one in the Appwrite console for this project.", missingVariables: ["MCP_SERVER_NAME", "MCP_AUTH_MODE", "MCP_AUTH_TOKEN", "MCP_TOOL_TIMEOUT"] } });
  assert.equal(String(calls[0].url), "https://cloud.appwrite.io/v1/tablesdb/void_control_plane");
  assert.deepEqual(JSON.parse(calls.find((call) => String(call.url).endsWith("/storage/buckets")).init.body), appwriteManifest.bucket);
  const platformPost = calls.find((call) => call.init.method === "POST" && String(call.url).endsWith("/projects/project/platforms"));
  assert.ok(platformPost);
  assert.equal(platformPost.init.headers["x-appwrite-key"], config.provisionKey);
  const functionPost = calls.find((call) => call.init.method === "POST" && String(call.url).endsWith("/functions"));
  assert.equal(String(functionPost.url), "https://cloud.appwrite.io/v1/functions");
  assert.deepEqual(JSON.parse(functionPost.init.body), {
    functionId: "6abbae3e000f6f24ce2a",
    name: "MCP server",
    runtime: "python-3.14",
    entrypoint: "src/main.py",
    commands: "pip install -r requirements.txt",
    timeout: 30,
    execute: ["any"],
    scopes: [],
  });
  assert.equal(appwriteManifest.database.existing, true);
  assert.deepEqual(appwriteManifest.bucket.name, "VOID Documents");
  assert.deepEqual(appwriteManifest.platforms.map((platform) => [platform.platformId, platform.name]), [["void_web", "VOID Production"], ["void_local_web", "VOID Local Development"]]);
  assert.deepEqual(appwriteManifest.function.variables, ["MCP_SERVER_NAME", "MCP_AUTH_MODE", "MCP_AUTH_TOKEN", "MCP_TOOL_TIMEOUT"]);
  assert.deepEqual(readProvisionConfig({ APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_PROVISION_KEY: "admin-key", APPWRITE_WEB_ORIGINS: "https://void-tui.vercel.app,http://localhost" }).webOrigins, config.webOrigins);
  assert.throws(() => readProvisionConfig({ APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_PROVISION_KEY: "admin-key", APPWRITE_WEB_ORIGINS: "http://void-tui.vercel.app" }));
});

test("a conflict succeeds only after the existing resource matches the manifest", async () => {
  const calls = [];

  await assert.doesNotReject(() => provisionAppwrite(config, existingFetcher(calls)));
  assert.equal(calls.filter((call) => call.init.method === "GET").length, 6);
});

test("a project with a matching hosted MCP function refuses the create and changes nothing", async () => {
  const calls = [];

  const result = await provisionAppwrite(config, existingFetcher(calls));

  assert.equal(calls.filter((call) => call.init.method === "POST" && String(call.url).endsWith("/functions")).length, 1);
  assert.equal(calls.filter((call) => call.init.method === "GET" && String(call.url).endsWith("/6abbae3e000f6f24ce2a")).length, 1);
  assert.deepEqual(result.hostedMcp.missingVariables, []);
  assert.equal(result.hostedMcp.functionId, "6abbae3e000f6f24ce2a");
});

test("a hosted MCP function whose build differs from the manifest is refused by field name", async () => {
  const drifted = (override) => ({ function: { ...appwriteManifest.function, ...override } });

  await assert.rejects(() => provisionAppwrite(config, existingFetcher([], drifted({ entrypoint: "app.py" }))), /drift in entrypoint\./);
  await assert.rejects(() => provisionAppwrite(config, existingFetcher([], drifted({ runtime: "python-3.13" }))), /drift in runtime\./);
  await assert.rejects(() => provisionAppwrite(config, existingFetcher([], drifted({ commands: "pip install ." }))), /drift in commands\./);
  await assert.rejects(() => provisionAppwrite(config, existingFetcher([], drifted({ timeout: 60 }))), /drift in timeout\./);
  await assert.rejects(() => provisionAppwrite(config, existingFetcher([], drifted({ execute: [] }))), /drift in execute\./);
});

test("a redeployment changes the deployment id and is not manifest drift", async () => {
  const calls = [];
  const redeployed = async (url, init = {}) => {
    const path = String(url);
    if (init.method === "GET" && path.endsWith("/6abbae3e000f6f24ce2a")) return body({ ...actualFunction(), deploymentId: "deployment-1111111111111111", latestDeploymentId: "deployment-1111111111111111" });
    return existingFetcher(calls)(url, init);
  };

  await assert.doesNotReject(() => provisionAppwrite(config, redeployed));
});

test("a hosted MCP function with no public domain reports the console action and does not fail", async () => {
  const calls = [];

  const result = await provisionAppwrite(config, existingFetcher(calls));

  assert.equal(result.hostedMcp.url, null);
  assert.equal(result.hostedMcp.needsDomain, true);
  assert.equal(result.hostedMcp.reason, "The function has no registered public domain. Add one in the Appwrite console for this project.");

  const unreadable = await provisionAppwrite(config, existingFetcher([], { status: 401 }));

  assert.equal(unreadable.hostedMcp.needsDomain, true);
  assert.match(unreadable.hostedMcp.reason, /answered 401 for the function domains/);
});

test("a hosted MCP function with a public domain returns the client URL", async () => {
  const calls = [];

  const result = await provisionAppwrite(config, existingFetcher(calls, { domains: [{ $id: "domain-1", name: "mcp.void.example" }] }));

  assert.deepEqual(result.hostedMcp, { functionId: "6abbae3e000f6f24ce2a", url: "https://mcp.void.example", needsDomain: false, reason: null, missingVariables: [] });
});

test("a conflicting private bucket or platform with drift fails provisioning", async () => {
  const bucketDrift = async (url, init = {}) => {
    if (init.method === "POST") return body({}, 409);
    return body(String(url).includes("void_documents") ? { ...actualBucket(), $permissions: ["read(\"any\")"] } : expected(url));
  };
  const platformDrift = async (url, init = {}) => {
    if (init.method === "POST") return body({}, 409);
    return body(String(url).endsWith("/void_web") ? { ...actualPlatform(appwriteManifest.platforms[0]), hostname: "other.example" } : expected(url));
  };

  await assert.rejects(() => provisionAppwrite(config, bucketDrift), /drift/);
  await assert.rejects(() => provisionAppwrite(config, platformDrift), /drift/);
});

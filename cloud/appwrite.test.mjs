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

function expected(path) {
  path = String(path);
  if (path.includes("/tablesdb/")) return { $id: "void_control_plane" };
  if (path.includes("void_documents")) return actualBucket();
  const platform = appwriteManifest.platforms.find((entry) => path.endsWith(`/${entry.platformId}`));
  return platform ? actualPlatform(platform) : {};
}

test("provisioner uses the live control plane resource IDs and permits only exact local development", async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    return body(expected(url), init.method === "GET" ? 200 : 201);
  };

  const result = await provisionAppwrite(config, fetcher);

  assert.deepEqual(result, { databaseId: "void_control_plane", bucketId: "void_documents", platforms: ["void_web", "void_local_web"] });
  assert.equal(String(calls[0].url), "https://cloud.appwrite.io/v1/tablesdb/void_control_plane");
  assert.deepEqual(JSON.parse(calls.find((call) => String(call.url).endsWith("/storage/buckets")).init.body), appwriteManifest.bucket);
  const platformPost = calls.find((call) => call.init.method === "POST" && String(call.url).endsWith("/projects/project/platforms"));
  assert.ok(platformPost);
  assert.equal(platformPost.init.headers["x-appwrite-key"], config.provisionKey);
  assert.equal(appwriteManifest.database.existing, true);
  assert.deepEqual(appwriteManifest.bucket.name, "VOID Documents");
  assert.deepEqual(appwriteManifest.platforms.map((platform) => [platform.platformId, platform.name]), [["void_web", "VOID Production"], ["void_local_web", "VOID Local Development"]]);
  assert.deepEqual(readProvisionConfig({ APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_PROVISION_KEY: "admin-key", APPWRITE_WEB_ORIGINS: "https://void-tui.vercel.app,http://localhost" }).webOrigins, config.webOrigins);
  assert.throws(() => readProvisionConfig({ APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_PROVISION_KEY: "admin-key", APPWRITE_WEB_ORIGINS: "http://void-tui.vercel.app" }));
});

test("a conflict succeeds only after the existing resource matches the manifest", async () => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === "POST") return body({}, 409);
    return body(expected(url));
  };

  await assert.doesNotReject(() => provisionAppwrite(config, fetcher));
  assert.equal(calls.filter((call) => call.init.method === "GET").length, 4);
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

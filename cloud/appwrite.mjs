import { readFileSync } from "node:fs";

export const appwriteManifest = Object.freeze({
  database: Object.freeze({ id: "void_control_plane", existing: true }),
  bucket: Object.freeze({ bucketId: "void_documents", name: "VOID Documents", permissions: [], fileSecurity: true, enabled: true }),
  platforms: Object.freeze([
    Object.freeze({ platformId: "void_web", name: "VOID Production", hostname: "void-tui.vercel.app", origin: "https://void-tui.vercel.app" }),
    Object.freeze({ platformId: "void_local_web", name: "VOID Local Development", hostname: "localhost", origin: "http://localhost" }),
  ]),
});

function localEnv() {
  try {
    return Object.fromEntries(readFileSync(".env.local", "utf8").split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, "")]] : [];
    }));
  } catch { return {}; }
}

function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Appwrite endpoint must use HTTPS.");
  return new URL(`${url.pathname.replace(/\/$/, "")}/`, url.origin).href;
}

export function readProvisionConfig(env = { ...localEnv(), ...process.env }) {
  const projectId = env.APPWRITE_PROJECT_ID;
  const provisionKey = env.APPWRITE_PROVISION_KEY;
  const databaseId = env.APPWRITE_DATABASE_ID ?? appwriteManifest.database.id;
  const webOrigins = (env.APPWRITE_WEB_ORIGINS ?? appwriteManifest.platforms.map((platform) => platform.origin).join(",")).split(",").map((value) => value.trim()).filter(Boolean);
  if (!projectId || !provisionKey || !webOrigins.length || webOrigins.some((origin) => !appwriteManifest.platforms.some((platform) => platform.origin === origin)))
    throw new Error("Provisioning requires the exact Appwrite manifest origins and APPWRITE_PROVISION_KEY.");
  return { endpoint: endpoint(env.APPWRITE_ENDPOINT), projectId, provisionKey, databaseId, webOrigins };
}

const same = (actual, expected, fields) => fields.every((field) => JSON.stringify(actual?.[field]) === JSON.stringify(expected[field]));

export async function provisionAppwrite(config = readProvisionConfig(), fetcher = fetch) {
  const base = endpoint(config.endpoint);
  const request = async (path, method, body) => {
    const response = await fetcher(new URL(path, base), {
      method,
      headers: { "content-type": "application/json", "x-appwrite-project": config.projectId, "x-appwrite-key": config.provisionKey },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    let result = {};
    if (response.status !== 204) try { result = await response.json(); } catch {}
    return { response, result };
  };
  const database = await request(`tablesdb/${encodeURIComponent(config.databaseId)}`, "GET");
  if (!database.response.ok || database.result.$id !== config.databaseId) throw new Error("Appwrite control plane database drift.");
  const ensure = async (createPath, readPath, resource, fields, normalize) => {
    const created = await request(createPath, "POST", resource);
    if (created.response.ok) return;
    if (created.response.status !== 409) throw new Error(`Appwrite provision failed: ${created.response.status}`);
    const existing = await request(readPath, "GET");
    if (!existing.response.ok || !same(normalize(existing.result), resource, fields)) throw new Error("Appwrite manifest drift.");
  };
  const bucket = (value) => ({ bucketId: value.$id, name: value.name, permissions: value.$permissions, fileSecurity: value.fileSecurity, enabled: value.enabled });
  const platform = (value) => ({ platformId: value.$id, name: value.name, hostname: value.hostname });
  await ensure("storage/buckets", `storage/buckets/${appwriteManifest.bucket.bucketId}`, appwriteManifest.bucket, ["bucketId", "name", "permissions", "fileSecurity", "enabled"], bucket);
  const platforms = appwriteManifest.platforms.filter((platform) => config.webOrigins.includes(platform.origin));
  for (const item of platforms)
    await ensure(`projects/${encodeURIComponent(config.projectId)}/platforms`, `projects/${encodeURIComponent(config.projectId)}/platforms/${item.platformId}`, item, ["platformId", "name", "hostname"], platform);
  return { databaseId: config.databaseId, bucketId: appwriteManifest.bucket.bucketId, platforms: platforms.map((platform) => platform.platformId) };
}

if (import.meta.url === `file://${process.argv[1]}`)
  provisionAppwrite().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });

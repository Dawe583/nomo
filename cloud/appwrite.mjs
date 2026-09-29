import { readFileSync } from "node:fs";

/**
 * The hosted reference MCP, declared from the live function. Its root
 * directory is `apps/appwrite-mcp` and it has to stay a read-only reference:
 * public project information and the local recovery tool catalogue, no
 * repository file serving, no credential, no write. A reader who cannot see
 * that boundary will add file serving to it. The environment variables are
 * named because the function reads them; their values belong to the operator
 * in the Appwrite console, so no value is ever declared here.
 */
export const appwriteManifest = Object.freeze({
  database: Object.freeze({ id: "void_control_plane", existing: true }),
  bucket: Object.freeze({ bucketId: "void_documents", name: "VOID Documents", permissions: [], fileSecurity: true, enabled: true }),
  platforms: Object.freeze([
    Object.freeze({ platformId: "void_web", name: "VOID Production", hostname: "void-tui.vercel.app", origin: "https://void-tui.vercel.app" }),
    Object.freeze({ platformId: "void_local_web", name: "VOID Local Development", hostname: "localhost", origin: "http://localhost" }),
  ]),
  function: Object.freeze({
    functionId: "6abbae3e000f6f24ce2a",
    name: "MCP server",
    runtime: "python-3.14",
    entrypoint: "src/main.py",
    commands: "pip install -r requirements.txt",
    timeout: 30,
    execute: Object.freeze(["any"]),
    scopes: Object.freeze([]),
    variables: Object.freeze(["MCP_SERVER_NAME", "MCP_AUTH_MODE", "MCP_AUTH_TOKEN", "MCP_TOOL_TIMEOUT"]),
  }),
});

/** The first field the live resource disagrees with, so the refusal names it. */
const driftField = (actual, expected, fields) => fields.find((field) => JSON.stringify(actual?.[field]) !== JSON.stringify(expected[field])) ?? null;

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
    if (created.response.ok) return created.result;
    if (created.response.status !== 409) throw new Error(`Appwrite provision failed: ${created.response.status}`);
    const existing = await request(readPath, "GET");
    if (!existing.response.ok) throw new Error("Appwrite manifest drift.");
    const field = driftField(normalize(existing.result), resource, fields);
    if (field) throw new Error(`Appwrite manifest drift in ${field}.`);
    return existing.result;
  };
  const bucket = (value) => ({ bucketId: value.$id, name: value.name, permissions: value.$permissions, fileSecurity: value.fileSecurity, enabled: value.enabled });
  const platform = (value) => ({ platformId: value.$id, name: value.name, hostname: value.hostname });
  await ensure("storage/buckets", `storage/buckets/${appwriteManifest.bucket.bucketId}`, appwriteManifest.bucket, ["bucketId", "name", "permissions", "fileSecurity", "enabled"], bucket);
  const platforms = appwriteManifest.platforms.filter((platform) => config.webOrigins.includes(platform.origin));
  for (const item of platforms)
    await ensure(`projects/${encodeURIComponent(config.projectId)}/platforms`, `projects/${encodeURIComponent(config.projectId)}/platforms/${item.platformId}`, item, ["platformId", "name", "hostname"], platform);
  const mcp = appwriteManifest.function;
  const createFunction = { functionId: mcp.functionId, name: mcp.name, runtime: mcp.runtime, entrypoint: mcp.entrypoint, commands: mcp.commands, timeout: mcp.timeout, execute: mcp.execute, scopes: mcp.scopes };
  const readFunction = (value) => ({ functionId: value.$id, name: value.name, runtime: value.runtime, entrypoint: value.entrypoint, commands: value.commands, timeout: value.timeout, execute: value.execute, scopes: value.scopes });
  const deployed = await ensure("functions", `functions/${encodeURIComponent(mcp.functionId)}`, createFunction, ["functionId", "name", "runtime", "entrypoint", "commands", "timeout", "execute", "scopes"], readFunction);
  const set = new Set((Array.isArray(deployed?.vars) ? deployed.vars : []).map((variable) => variable.key));
  const missingVariables = mcp.variables.filter((name) => !set.has(name));
  // A public domain is a console-scoped resource. The domain routes reject the
  // project service key this repository holds with general_access_forbidden,
  // and adding a domain is a console action rather than manifest drift, so an
  // absent or unreadable domain is reported in the result and never thrown.
  const domains = await request(`functions/${encodeURIComponent(mcp.functionId)}/domains`, "GET");
  const domain = Array.isArray(domains.result?.domains) ? domains.result.domains[0]?.name : undefined;
  const hostedMcp = {
    functionId: mcp.functionId,
    url: domain ? `https://${domain}` : null,
    needsDomain: !domain,
    reason: domain ? null : domains.response.ok
      ? "The function has no registered public domain. Add one in the Appwrite console for this project."
      : `The Appwrite API answered ${domains.response.status} for the function domains, so this provision key cannot read them. Add a public domain in the Appwrite console.`,
    missingVariables,
  };
  return { databaseId: config.databaseId, bucketId: appwriteManifest.bucket.bucketId, platforms: platforms.map((platform) => platform.platformId), hostedMcp };
}

if (import.meta.url === `file://${process.argv[1]}`)
  provisionAppwrite().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });

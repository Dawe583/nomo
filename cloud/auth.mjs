import { envValue } from './env.mjs';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

const COOKIE = "__Host-void-auth";
const fail = (code = "authentication_required", status = 401) => Object.assign(new Error("Authentication required."), { code, status });

function cookieValue(cookie) {
  return cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
}

function keyBytes(key) { return Buffer.from(key, "hex"); }

function httpsUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${label} must use HTTPS.`);
  return url;
}

function endpoint(value) {
  const url = httpsUrl(value, "Appwrite endpoint");
  return new URL(`${url.pathname.replace(/\/$/, "")}/`, url.origin).href;
}

export function sealSession(session, key, now = Date.now()) {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", keyBytes(key), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(session)), cipher.final()]);
  const value = [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString("base64url")).join(".");
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((session.expiresAt - now) / 1000))}`;
}

export function clearSession() { return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }

export function unsealSession(cookie, key, now = Date.now()) {
  const [iv, ciphertext, tag, extra] = cookieValue(cookie)?.split(".") ?? [];
  if (!iv || !ciphertext || !tag || extra) return undefined;
  try {
    const cipher = createDecipheriv("aes-256-gcm", keyBytes(key), Buffer.from(iv, "base64url"));
    cipher.setAuthTag(Buffer.from(tag, "base64url"));
    const result = JSON.parse(Buffer.concat([cipher.update(Buffer.from(ciphertext, "base64url")), cipher.final()]).toString());
    return /^[a-f0-9-]{1,80}$/.test(result.id) && Number.isSafeInteger(result.expiresAt) && result.expiresAt > now ? result : undefined;
  } catch { return undefined; }
}

/**
 * `APPWRITE_*` are Appwrite's names, not ours, so they are read straight from
 * the injected object: aliasing them would mean owning a variable the upstream
 * provider defines. `NOMO_AUTH_SEAL_KEY` and `NOMO_PUBLIC_ORIGIN` are ours and
 * keep the legacy spelling working.
 *
 * The message names the variables and never their values: a deployment that
 * got the seal key wrong must be able to see which one, and must not be able to
 * read a key out of its own error.
 */
export function readAuthConfig(env = process.env) {
  const projectId = env.APPWRITE_PROJECT_ID,
    runtimeKey = env.APPWRITE_RUNTIME_KEY,
    sealKey = envValue(env, "NOMO_AUTH_SEAL_KEY");
  if (!projectId || !runtimeKey || !/^[a-f0-9]{64}$/i.test(sealKey ?? ""))
    throw new Error("Appwrite auth requires APPWRITE_PROJECT_ID, APPWRITE_RUNTIME_KEY and NOMO_AUTH_SEAL_KEY.");
  const publicOrigin = httpsUrl(envValue(env, "NOMO_PUBLIC_ORIGIN"), "NOMO_PUBLIC_ORIGIN").origin;
  return { endpoint: endpoint(env.APPWRITE_ENDPOINT), projectId, runtimeKey, sealKey, publicOrigin, sessionSeconds: 60 * 60 * 24 * 7 };
}

export function createAuth({ config = readAuthConfig(), sessions, fetcher = fetch, logger = console, now = Date.now, randomId = randomUUID }) {
  if (!sessions?.create || !sessions?.read || !sessions?.revoke) throw new Error("Appwrite auth session storage is required.");
  const base = endpoint(config.endpoint);
  const validStored = (stored, id, expiresAt) => stored && stored.id === id && stored.expiresAt === expiresAt && typeof stored.secret === "string" && stored.secret.length > 0 && typeof stored.userId === "string" && stored.userId.length > 0;
  const request = async (path, method, body, sessionSecret) => {
    const response = await fetcher(new URL(path, base), {
      method,
      headers: { "content-type": "application/json", "x-appwrite-project": config.projectId, ...(sessionSecret ? { "x-appwrite-session": sessionSecret } : { "x-appwrite-key": config.runtimeKey }) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw fail("authentication_failed", response.status);
    if (response.status === 204) return {};
    try { return await response.json(); } catch { throw fail("authentication_failed", 401); }
  };
  const local = async (cookie) => {
    const claim = unsealSession(cookie, config.sealKey, now());
    if (!claim) throw fail();
    const stored = await sessions.read(claim.id);
    if (!validStored(stored, claim.id, claim.expiresAt) || stored.revokedAt || stored.expiresAt <= now()) throw fail();
    return { claim, stored };
  };
  return {
    async signup({ email, password, name }) { await request("account", "POST", { userId: "unique()", email, password, name }); return { ok: true }; },
    async login({ email, password }) {
      const appwrite = await request("account/sessions/email", "POST", { email, password });
      if (typeof appwrite.secret !== "string" || typeof appwrite.userId !== "string") throw fail("authentication_failed", 401);
      const expiresAt = now() + config.sessionSeconds * 1000, id = randomId();
      const stored = await sessions.create({ id, secret: appwrite.secret, userId: appwrite.userId, expiresAt });
      if (!validStored(stored, id, expiresAt) || stored.secret !== appwrite.secret || stored.userId !== appwrite.userId) throw fail("session_create_failed", 503);
      return { userId: appwrite.userId, setCookie: sealSession({ id, expiresAt }, config.sealKey, now()) };
    },
    async logout(cookie) {
      const { claim, stored } = await local(cookie);
      try { await sessions.revoke(claim.id); } catch { throw fail("session_revoke_failed", 503); }
      try { await request("account/sessions/current", "DELETE", undefined, stored.secret); } catch (error) { logger?.warn?.("void.auth.remote_logout_failed", { status: error.status ?? 0 }); }
      return { setCookie: clearSession() };
    },
    async me(cookie) { const { stored } = await local(cookie); const account = await request("account", "GET", undefined, stored.secret); if (typeof account.$id !== "string" || account.$id !== stored.userId) throw fail("authentication_failed", 401); return { id: account.$id, email: account.email, name: account.name }; },
    async recover({ email }) { await request("account/recovery", "POST", { email, url: new URL("reset-password", `${httpsUrl(config.publicOrigin, "NOMO_PUBLIC_ORIGIN").origin}/`).href }); return { ok: true }; },
  };
}

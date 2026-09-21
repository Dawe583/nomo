import assert from "node:assert/strict";
import test from "node:test";

import { createAuth, readAuthConfig, sealSession, unsealSession } from "./auth.mjs";

const key = "A".repeat(64);
const config = {
  endpoint: "https://cloud.appwrite.io/v1",
  projectId: "project",
  runtimeKey: "runtime-credential",
  sealKey: key,
  publicOrigin: "https://void-tui.vercel.app",
  sessionSeconds: 3600,
};

function fakeFetch(replies, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    const reply = replies.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
}

function memorySessions() {
  const values = new Map();
  return {
    async create(value) { if (values.has(value.id)) return values.get(value.id); values.set(value.id, value); return value; },
    async read(id) { return values.get(id); },
    async revoke(id) { const value = values.get(id); if (!value) throw new Error("missing"); value.revokedAt = 1; },
  };
}

test("login uses HTTPS, keeps Appwrite secrets out of response, logs and sealed cookie", async () => {
  const calls = [], logs = [], sessions = memorySessions();
  const auth = createAuth({ config, sessions, fetcher: fakeFetch([{ status: 201, body: { $id: "app-session", secret: "appwrite-session-secret", userId: "user" } }], calls), logger: { warn: (...entry) => logs.push(entry) }, now: () => 1000, randomId: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });

  const result = await auth.login({ email: "a@example.com", password: "correct horse battery staple" });

  assert.deepEqual(result, { userId: "user", setCookie: result.setCookie });
  assert.match(result.setCookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.doesNotMatch(result.setCookie, /appwrite-session-secret|runtime-credential/);
  assert.doesNotMatch(Buffer.from(result.setCookie.split("=")[1].split(".")[0], "base64url").toString(), /aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/);
  assert.equal(JSON.stringify(logs).includes("appwrite-session-secret"), false);
  assert.equal(String(calls[0].url), "https://cloud.appwrite.io/v1/account/sessions/email");
  assert.equal(calls[0].init.headers["x-appwrite-key"], "runtime-credential");
  assert.deepEqual(unsealSession(result.setCookie, config.sealKey, 1001), { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", expiresAt: 3601000 });
});

test("an invalid endpoint, tampered cookie, expired cookie or invalid stored record cannot load an account", async () => {
  assert.throws(() => readAuthConfig({ APPWRITE_ENDPOINT: "http://localhost/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_RUNTIME_KEY: "runtime", VOID_AUTH_SEAL_KEY: key, VOID_PUBLIC_ORIGIN: "https://void-tui.vercel.app" }), /HTTPS/);
  assert.throws(() => readAuthConfig({ APPWRITE_ENDPOINT: "https://cloud.appwrite.io/v1", APPWRITE_PROJECT_ID: "project", APPWRITE_PROVISION_KEY: "elevated-only", VOID_AUTH_SEAL_KEY: key, VOID_PUBLIC_ORIGIN: "https://void-tui.vercel.app" }), /APPWRITE_RUNTIME_KEY/);
  const calls = [], sessions = memorySessions();
  await sessions.create({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", secret: "appwrite-session-secret", userId: "user", expiresAt: 2000 });
  const auth = createAuth({ config, sessions, fetcher: fakeFetch([], calls), now: () => 3000 });
  const cookie = sealSession({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", expiresAt: 2000 }, config.sealKey);

  await assert.rejects(() => auth.me(cookie.replace(/.$/, "x")), { code: "authentication_required" });
  await assert.rejects(() => auth.me(cookie), { code: "authentication_required" });
  assert.equal(calls.length, 0);
});

test("logout requires durable revocation, then clears cookie if remote cleanup fails", async () => {
  const calls = [], logs = [], sessions = memorySessions();
  await sessions.create({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", secret: "appwrite-session-secret", userId: "user", expiresAt: 9000 });
  const auth = createAuth({ config, sessions, fetcher: fakeFetch([{ status: 503, body: {} }], calls), logger: { warn: (...entry) => logs.push(entry) }, now: () => 1000 });
  const cookie = sealSession({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", expiresAt: 9000 }, config.sealKey);

  const result = await auth.logout(cookie);
  assert.match(result.setCookie, /Max-Age=0/);
  await assert.rejects(() => auth.me(cookie), { code: "authentication_required" });
  assert.equal(calls[0].init.headers["x-appwrite-session"], "appwrite-session-secret");
  assert.deepEqual(logs, [["void.auth.remote_logout_failed", { status: 503 }]]);
  const unavailable = memorySessions();
  await unavailable.create({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", secret: "appwrite-session-secret", userId: "user", expiresAt: 9000 });
  const failing = createAuth({ config, sessions: { ...unavailable, revoke: async () => { throw new Error("down"); } }, fetcher: fakeFetch([], []), now: () => 1000 });
  await assert.rejects(() => failing.logout(cookie), { code: "session_revoke_failed" });
});

test("login rejects a session store record that was not created exactly", async () => {
  const sessions = { ...memorySessions(), create: async (value) => ({ ...value, secret: "different" }) };
  const auth = createAuth({ config, sessions, fetcher: fakeFetch([{ status: 201, body: { secret: "appwrite-session-secret", userId: "user" } }]), now: () => 1000, randomId: () => "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
  await assert.rejects(() => auth.login({ email: "a@example.com", password: "correct horse battery staple" }), { code: "session_create_failed" });
});

test("signup and recovery return no Appwrite payload and recovery URL is configured", async () => {
  const calls = [];
  const auth = createAuth({ config, sessions: memorySessions(), fetcher: fakeFetch([{ status: 201, body: { $id: "user", email: "a@example.com" } }, { status: 201, body: {} }], calls), now: () => 1000 });

  assert.deepEqual(await auth.signup({ email: "a@example.com", password: "correct horse battery staple", name: "A" }), { ok: true });
  assert.deepEqual(await auth.recover({ email: "a@example.com", url: "https://attacker.example" }), { ok: true });
  assert.equal(String(calls[0].url), "https://cloud.appwrite.io/v1/account");
  assert.deepEqual(JSON.parse(calls[1].init.body), { email: "a@example.com", url: "https://void-tui.vercel.app/reset-password" });
});

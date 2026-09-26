/**
 * The account broker and the owner it produces.
 *
 * The identity provider is server side only, so the browser never holds a
 * provider token and `vercel.json` never learns a provider origin. That is a
 * design constraint, not an oversight, and one of the checks below fails if the
 * CSP is widened to make the broker's life easier.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FAILURE_STATUS,
  SESSION_COOKIE,
  accountServiceFromEnv,
  clearSessionCookie,
  createAccountService,
  openSession,
  readSessionCookie,
  sealSession,
  setSessionCookie,
  signupAllowed,
} from "./account.mjs";
import { openOwnerState, sealOwnerState } from "./oauth-state.mjs";
import { OPERATOR_OWNER } from "./owner.mjs";

const root = new URL("..", import.meta.url).pathname;
const SEAL_KEY = "a".repeat(64);
const session = (over = {}) => ({
  userId: "3f2b1c4e-0000-4000-8000-000000000000",
  email: "person@example.com",
  accessToken: "provider-access-token",
  refreshToken: "provider-refresh-token",
  expiresAt: Date.now() + 60000,
  ...over,
});

test("the account cookie is sealed, and a tampered one does not open", () => {
  const sealed = sealSession(session(), SEAL_KEY);
  assert.deepEqual(openSession(sealed, SEAL_KEY).userId, session().userId);
  for (const bad of [
    sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A"),
    "not-a-cookie",
    "only.two",
    "",
    undefined,
    null,
    42,
  ])
    assert.equal(openSession(bad, SEAL_KEY), null, `${bad} must not open`);
  // A different deployment's key opens nothing.
  assert.equal(openSession(sealed, "b".repeat(64)), null);
  // And an expired one opens as no session rather than as an error.
  assert.equal(
    openSession(sealSession(session({ expiresAt: Date.now() - 1 }), SEAL_KEY), SEAL_KEY),
    null,
  );
});

test("the cookie is host prefixed, HttpOnly, Secure and Lax", () => {
  assert.equal(SESSION_COOKIE, "__Host-void-account");
  const headers = {};
  setSessionCookie({ setHeader: (name, value) => (headers[name] = value) }, "sealed");
  assert.equal(
    headers["set-cookie"],
    "__Host-void-account=sealed; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000",
  );
  clearSessionCookie({ setHeader: (name, value) => (headers[name] = value) });
  assert.match(headers["set-cookie"], /Max-Age=0$/);
  // The parser looks at this cookie and nothing else.
  assert.equal(
    readSessionCookie({ headers: { cookie: `other=1; ${SESSION_COOKIE}=sealed` } }),
    "sealed",
  );
  assert.equal(readSessionCookie({ headers: { cookie: "other=1" } }), undefined);
});

test("a deployment with no provider configured can issue no session", async () => {
  const service = accountServiceFromEnv({});
  assert.equal(service.isConfigured(), false);
  assert.deepEqual(await service.signIn({ method: "password", email: "a@b.c", password: "x" }), {
    failure: "provider_error",
  });
  assert.equal(FAILURE_STATUS.provider_error, 502);
});

test("sign up is off: a password sign-in for an unknown account never asks the provider to create one", async () => {
  const asked = [];
  const service = createAccountService({
    supabaseUrl: "https://provider.invalid",
    supabaseKey: "anon",
    sessionSecret: SEAL_KEY,
    siteOrigin: "https://chat.voidagent.tech",
    env: {},
    fetchImpl: async (url, init) => {
      asked.push(String(url));
      if (String(url).includes("/token"))
        return Response.json(
          { error_code: "invalid_grant", msg: "Invalid login credentials" },
          { status: 400 },
        );
      return Response.json({ id: "provider-user", email: "person@example.com" });
    },
  });
  assert.equal(service.isConfigured(), true);
  assert.equal(signupAllowed({}), false);
  const result = await service.signIn({
    method: "password",
    email: "person@example.com",
    password: "correct horse",
    invite: "invite-code",
  });
  assert.deepEqual(result, { failure: "invite_required" });
  assert.equal(FAILURE_STATUS.invite_required, 403);
  assert.ok(
    asked.every((url) => !url.endsWith("/signup")),
    "no account may be created while signup is off",
  );
});

test("with the switch on, an invited unknown account is created and the provider is asked who it is", async () => {
  const asked = [];
  const service = createAccountService({
    supabaseUrl: "https://provider.invalid",
    supabaseKey: "anon",
    sessionSecret: SEAL_KEY,
    siteOrigin: "https://chat.voidagent.tech",
    env: { VOID_ACCOUNT_SIGNUP: "1" },
    fetchImpl: async (url) => {
      asked.push(String(url));
      if (String(url).includes("/token"))
        return Response.json(
          { error_code: "invalid_grant" },
          { status: 400 },
        );
      if (String(url).endsWith("/signup"))
        return Response.json({ access_token: "fresh", refresh_token: "r" });
      return Response.json({ id: "provider-user", email: "Person@Example.com" });
    },
  });
  const result = await service.signIn({
    method: "password",
    email: "person@example.com",
    password: "correct horse",
    invite: "invite-code",
  });
  assert.equal(result.session.userId, "provider-user");
  assert.equal(result.session.email, "person@example.com");
  assert.ok(asked.some((url) => url.endsWith("/signup")));
  // Without the invitation the same request creates nothing.
  asked.length = 0;
  assert.deepEqual(
    await service.signIn({
      method: "password",
      email: "person@example.com",
      password: "correct horse",
    }),
    { failure: "invite_required" },
  );
  assert.ok(asked.every((url) => !url.endsWith("/signup")));
});

test("a magic link is a login and never a registration", async () => {
  const bodies = [];
  const service = createAccountService({
    supabaseUrl: "https://provider.invalid",
    supabaseKey: "anon",
    sessionSecret: SEAL_KEY,
    siteOrigin: "https://chat.voidagent.tech",
    env: {},
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body ?? "null"));
      if (String(url).endsWith("/otp")) return Response.json({}, { status: 200 });
      return Response.json({ id: "provider-user", email: "person@example.com" });
    },
  });
  assert.deepEqual(
    await service.signIn({ method: "magic_link_request", email: "person@example.com" }),
    { session: null },
  );
  assert.equal(bodies[0].create_user, false);
  const result = await service.signIn({
    method: "magic_link",
    access_token: "from-the-link",
  });
  assert.equal(result.session.userId, "provider-user");
});

test("the provider decides who the caller is, and an unverified token is nobody", async () => {
  const service = createAccountService({
    supabaseUrl: "https://provider.invalid",
    supabaseKey: "anon",
    sessionSecret: SEAL_KEY,
    siteOrigin: "https://chat.voidagent.tech",
    env: {},
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, "Bearer revoked-token");
      return Response.json({ msg: "invalid" }, { status: 401 });
    },
  });
  assert.equal(await service.whoIs("revoked-token"), null);
  assert.equal(await service.whoIs(""), null);
  assert.equal(await service.whoIs(undefined), null);
});

test("the OAuth state carries the owner sealed, and the provider cannot read it", () => {
  process.env.VOID_SECRET_KEY = Buffer.alloc(32, 3).toString("base64");
  const nonce = "A".repeat(43);
  const authorize = "https://provider.invalid/authorize?state=" + nonce + "&scope=x";
  const flow = { state: nonce, binding: "B".repeat(43), url: authorize };
  const sealed = sealOwnerState(OPERATOR_OWNER, flow);
  assert.match(sealed.url, /^https:\/\/provider\.invalid\/authorize\?/);
  // The binding the callback checks survives, or the flow cannot prove it
  // returned to the browser that started it.
  assert.equal(sealed.binding, flow.binding);
  const sent = new URL(sealed.url).searchParams.get("state");
  assert.notEqual(sent, nonce);
  assert.doesNotMatch(sent, new RegExp(OPERATOR_OWNER));
  assert.deepEqual(openOwnerState(sent), { owner: OPERATOR_OWNER, nonce });
  // A state this deployment did not seal names no owner, and the flow fails.
  assert.equal(openOwnerState(nonce), null);
  assert.equal(openOwnerState(`${sent}tampered`), null);
  assert.equal(openOwnerState(undefined), null);
});

test("the identity provider is server side only", () => {
  const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));
  const headers = JSON.stringify(vercel.headers ?? []);
  assert.match(headers, /connect-src 'self'/);
  assert.doesNotMatch(
    headers,
    /supabase|supabase\.co/i,
    "the browser must never be pointed at the identity provider",
  );
});

test("a request with no verified session is refused, and the refusal is not an empty result", async (t) => {
  const providerUser = "3f2b1c4e-0000-4000-8000-000000000000";
  process.env.SUPABASE_URL = "https://provider.invalid";
  process.env.SUPABASE_ANON_KEY = "anon";
  process.env.VOID_ACCOUNT_SEAL_KEY = SEAL_KEY;
  process.env.VOID_CONTROL_TOKEN = "operator-token-for-this-test-".padEnd(40, "x");
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1")) return nativeFetch(url, init);
    assert.match(target, /\/auth\/v1\/user$/);
    if (init.headers.Authorization === "Bearer revoked")
      return Response.json({ msg: "invalid" }, { status: 401 });
    return Response.json({ id: providerUser, email: "person@example.com" });
  };
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });
  const { default: app } = await import("./server.mjs");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (headers) => {
    const response = await fetch(`${base}/api/capabilities`, { headers });
    return response.status;
  };
  const sealed = sealSession(session(), SEAL_KEY);

  // The operator's own path keeps working.
  assert.equal(
    await call({ authorization: `Bearer ${process.env.VOID_CONTROL_TOKEN}` }),
    200,
  );
  // A verified account is in.
  assert.equal(await call({ cookie: `${SESSION_COOKIE}=${sealed}` }), 200);
  // An account whose provider token no longer resolves is nobody, not a
  // degraded account and not an empty workspace.
  assert.equal(
    await call({ cookie: `${SESSION_COOKIE}=${sealSession(session({ accessToken: "revoked" }), SEAL_KEY)}` }),
    401,
  );
  // A cookie this deployment did not seal is nobody.
  assert.equal(await call({ cookie: `${SESSION_COOKIE}=forged` }), 401);
  // Neither credential at all is nobody.
  assert.equal(await call({}), 401);
});

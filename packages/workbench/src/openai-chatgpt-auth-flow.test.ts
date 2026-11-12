import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { OpenAIChatGPTAuthStore } from "./openai-chatgpt-auth.ts";
import { OpenAIChatGPTAuthError, OpenAIChatGPTAuthService } from "./openai-chatgpt-login.ts";

const scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });

function signedIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
}

test("first SIWC attempt validates callback and ID token before storing account credentials", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-flow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let issuedIdToken = "";
  let grantedScope = scope;
  let revocationAttempts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === "https://auth.openai.com/.well-known/openid-configuration")
      return Response.json({
        issuer: "https://auth.openai.com",
        jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
        token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
        revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke",
      });
    if (url === "https://auth.openai.com/.well-known/jwks.json")
      return Response.json({ keys: [{ ...jwk, kid: "fixture-key", alg: "RS256", use: "sig" }] });
    if (url === "https://auth.openai.com/api/accounts/oauth/revoke") {
      revocationAttempts++;
      return revocationAttempts === 1
        ? Response.json({ error: "temporarily_unavailable" }, { status: 503 })
        : new Response(null, { status: 200 });
    }
    if (url === "https://auth.openai.com/api/accounts/oauth/token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token")
        return Response.json({
          access_token: "rotated-access-secret",
          refresh_token: "rotated-refresh-secret",
          token_type: "Bearer",
          expires_in: 3600,
          scope: grantedScope,
        });
      return Response.json({
        access_token: "access-fixture-secret",
        refresh_token: "refresh-fixture-secret",
        id_token: issuedIdToken,
        token_type: "Bearer",
        expires_in: 1,
        scope: grantedScope,
      });
    }
    assert.fail(`Unexpected fixture URL: ${url}`);
  };
  const service = new OpenAIChatGPTAuthService({
    store,
    fetcher,
    agentNameHint: "NOMO",
  });

  const attempt = await service.beginSignIn();
  const authorization = new URL(attempt.authorizationUrl);
  assert.equal(authorization.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(authorization.searchParams.get("redirect_uri")?.startsWith("http://127.0.0.1:"), true);
  assert.equal(authorization.searchParams.get("redirect_uri")?.endsWith("/auth/callback"), true);
  assert.equal(authorization.searchParams.has("id_token_hint"), false);
  assert.equal(authorization.searchParams.has("login_hint"), false);

  const issuedClientId = "oaiapp-issued-fixture";
  issuedIdToken = signedIdToken({
    iss: "https://auth.openai.com",
    aud: issuedClientId,
    sub: "account-subject-fixture",
    email: "fixture@example.invalid",
    email_verified: true,
    nonce: authorization.searchParams.get("nonce"),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "authorization-code-fixture");
  callback.searchParams.set("state", "wrong-state");
  callback.searchParams.set("client_id", issuedClientId);
  const refused = await fetch(callback);
  assert.equal(refused.status, 400);
  assert.deepEqual(service.attempt(attempt.id)?.status, "pending");

  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.delete("client_id");
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(requests.length, 0);
  callback.searchParams.set("client_id", issuedClientId);
  const absoluteTarget = new Promise<number | undefined>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: Number(callback.port),
      path: `http://example.invalid/auth/callback?${callback.searchParams}`,
      headers: { host: callback.host },
    }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(await absoluteTarget, 400);
  assert.equal(requests.length, 0);

  const accepted = await fetch(callback);
  assert.equal(accepted.status, 200);
  const completed = await service.waitForAttempt(attempt.id);
  assert.equal(completed.status, "connected");
  assert.equal(completed.email, "fixture@example.invalid");
  assert.equal(completed.usageEnabled, true);

  const saved = store.read();
  assert.equal(saved?.accounts.length, 1);
  assert.equal(saved?.accounts[0]?.clientId, issuedClientId);
  assert.equal(saved?.accounts[0]?.subject, "account-subject-fixture");
  assert.equal(saved?.accounts[0]?.accessToken, "access-fixture-secret");
  assert.equal("idToken" in (saved?.accounts[0] ?? {}), false);
  const encrypted = await readFile(join(directory, "host-auth", "workspace.enc"));
  assert.equal(encrypted.includes(Buffer.from("access-fixture-secret")), false);
  assert.equal(encrypted.includes(Buffer.from("refresh-fixture-secret")), false);

  const exchange = requests.find(request => request.url.endsWith("/api/accounts/oauth/token"));
  assert.ok(exchange);
  assert.equal(exchange.init?.method, "POST");
  assert.match(String(exchange.init?.body), /grant_type=authorization_code/);
  assert.match(String(exchange.init?.body), /client_id=oaiapp-issued-fixture/);
  assert.match(String(exchange.init?.body), /code_verifier=/);
  assert.match(String(exchange.init?.body), /resource=https%3A%2F%2Fapi.openai.com%2Fv1/);
  const verifier = new URLSearchParams(String(exchange.init?.body)).get("code_verifier");
  assert.ok(verifier);
  assert.equal(
    createHash("sha256").update(verifier).digest("base64url"),
    authorization.searchParams.get("code_challenge"),
  );

  const secondService = new OpenAIChatGPTAuthService({
    store: new OpenAIChatGPTAuthStore(join(directory, "host-auth")),
    fetcher,
    agentNameHint: "NOMO",
  });
  const [accessToken, concurrentToken] = await Promise.all([
    service.accessToken(completed.accountId!),
    secondService.accessToken(completed.accountId!),
  ]);
  assert.equal(accessToken, "rotated-access-secret");
  assert.equal(concurrentToken, "rotated-access-secret");
  assert.equal(requests.filter(request =>
    request.url.endsWith("/api/accounts/oauth/token") &&
    new URLSearchParams(String(request.init?.body)).get("grant_type") === "refresh_token",
  ).length, 1);
  assert.equal(store.read()?.accounts[0]?.accessToken, "rotated-access-secret");
  assert.equal(store.read()?.accounts[0]?.refreshToken, "rotated-refresh-secret");
  const refresh = requests.find(request =>
    request.url.endsWith("/api/accounts/oauth/token") &&
    new URLSearchParams(String(request.init?.body)).get("grant_type") === "refresh_token",
  );
  assert.ok(refresh);
  const refreshBody = new URLSearchParams(String(refresh.init?.body));
  assert.equal(refreshBody.get("client_id"), issuedClientId);
  assert.equal(refreshBody.get("resource"), "https://api.openai.com/v1");
  assert.equal(refreshBody.has("scope"), false);

  const disconnected = await service.disconnect(completed.accountId!);
  assert.equal(disconnected.remoteRevocationConfirmed, true);
  assert.equal(revocationAttempts, 2);
  const revocation = requests.find(request => request.url.endsWith("/api/accounts/oauth/revoke"));
  assert.ok(revocation);
  const revocationBody = new URLSearchParams(String(revocation.init?.body));
  assert.equal(revocationBody.get("client_id"), issuedClientId);
  assert.equal(revocationBody.get("token_type_hint"), "refresh_token");
  assert.equal(revocationBody.get("token"), "rotated-refresh-secret");
  assert.equal(store.read()?.accounts[0]?.usageEnabled, false);
  assert.equal("accessToken" in (store.read()?.accounts[0] ?? {}), false);

  const reauth = await service.beginSignIn({ accountId: completed.accountId, enablePlanUsage: true });
  const reauthUrl = new URL(reauth.authorizationUrl);
  assert.equal(reauthUrl.searchParams.get("client_id"), issuedClientId);
  assert.equal(reauthUrl.searchParams.get("prompt"), "consent");
  assert.equal(reauthUrl.searchParams.has("id_token_hint"), false);
  assert.equal(reauthUrl.searchParams.has("login_hint"), false);
  grantedScope = "openid profile email offline_access resource.invoke";
  issuedIdToken = signedIdToken({
    iss: "https://auth.openai.com",
    aud: issuedClientId,
    sub: "account-subject-fixture",
    email: "fixture@example.invalid",
    email_verified: true,
    nonce: reauthUrl.searchParams.get("nonce"),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const reauthCallback = new URL(reauthUrl.searchParams.get("redirect_uri")!);
  reauthCallback.searchParams.set("code", "reauth-code-fixture");
  reauthCallback.searchParams.set("state", reauthUrl.searchParams.get("state")!);
  assert.equal((await fetch(reauthCallback)).status, 200);
  const disabled = await service.waitForAttempt(reauth.id);
  assert.equal(disabled.status, "usage-disabled");
  assert.equal(disabled.usageEnabled, false);
  const disabledAccount = store.read()?.accounts[0];
  assert.equal(disabledAccount?.usageEnabled, false);
  assert.equal(disabledAccount?.id, completed.accountId);
  assert.equal(disabledAccount?.clientId, issuedClientId);
  assert.equal(disabledAccount?.subject, "account-subject-fixture");
  assert.equal(disabledAccount?.email, "fixture@example.invalid");
  assert.equal("accessToken" in (disabledAccount ?? {}), false);
  assert.equal("refreshToken" in (disabledAccount ?? {}), false);
  assert.equal("expiresAt" in (disabledAccount ?? {}), false);

  grantedScope = scope;
  const multiAudience = await service.beginSignIn({ accountId: completed.accountId });
  const multiAudienceUrl = new URL(multiAudience.authorizationUrl);
  issuedIdToken = signedIdToken({
    iss: "https://auth.openai.com",
    aud: [issuedClientId, "another-client"],
    sub: "account-subject-fixture",
    nonce: multiAudienceUrl.searchParams.get("nonce"),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const multiAudienceCallback = new URL(multiAudienceUrl.searchParams.get("redirect_uri")!);
  multiAudienceCallback.searchParams.set("code", "multi-audience-code");
  multiAudienceCallback.searchParams.set("state", multiAudienceUrl.searchParams.get("state")!);
  assert.equal((await fetch(multiAudienceCallback)).status, 200);
  assert.equal((await service.waitForAttempt(multiAudience.id)).status, "failed");
  assert.equal(store.read()?.accounts[0]?.usageEnabled, false);
  assert.equal("accessToken" in (store.read()?.accounts[0] ?? {}), false);
});

test("disconnect cancels a pending reauthorization before its credentials can be saved", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-disconnect-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
  const account = {
    id: "account-fixture",
    clientId: "oaiapp-fixture",
    subject: "subject-fixture",
    scopes: scope.split(" "),
    usageEnabled: true,
    accessToken: "existing-access-fixture",
    refreshToken: "existing-refresh-fixture",
    expiresAt: Date.now() + 3_600_000,
  };
  await store.update(state => ({ state: { ...state, accounts: [account] }, result: undefined }));
  let issuedToken = "";
  let releaseJwks!: (response: Response) => void;
  let markJwksRequested!: () => void;
  const jwksRequested = new Promise<void>(resolve => { markJwksRequested = resolve; });
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://auth.openai.com/api/accounts/oauth/token")
      return Response.json({
        access_token: "reauth-access-fixture",
        refresh_token: "reauth-refresh-fixture",
        id_token: issuedToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
    if (url === "https://auth.openai.com/.well-known/openid-configuration")
      return Response.json({
        issuer: "https://auth.openai.com",
        jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
        token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
        revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke",
      });
    if (url === "https://auth.openai.com/.well-known/jwks.json") {
      markJwksRequested();
      return await new Promise<Response>(resolve => { releaseJwks = resolve; });
    }
    if (url === "https://auth.openai.com/api/accounts/oauth/revoke")
      return new Response(null, { status: 200 });
    assert.fail(`Unexpected fixture URL: ${url}`);
  };
  const service = new OpenAIChatGPTAuthService({ store, fetcher, agentNameHint: "NOMO" });
  const attempt = await service.beginSignIn({ accountId: account.id });
  t.after(() => {
    service.cancelAttempt(attempt.id);
    if (releaseJwks) releaseJwks(Response.json({ keys: [{ ...jwk, kid: "fixture-key", alg: "RS256", use: "sig" }] }));
  });
  const authorization = new URL(attempt.authorizationUrl);
  issuedToken = signedIdToken({
    iss: "https://auth.openai.com",
    aud: account.clientId,
    sub: account.subject,
    nonce: authorization.searchParams.get("nonce"),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "reauth-code-fixture");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  assert.equal((await fetch(callback)).status, 200);
  await jwksRequested;

  const disconnectingService = new OpenAIChatGPTAuthService({
    store: new OpenAIChatGPTAuthStore(join(directory, "host-auth")),
    fetcher,
    agentNameHint: "NOMO",
  });
  const disconnected = await disconnectingService.disconnect(account.id);
  assert.equal(disconnected.remoteRevocationConfirmed, true);
  releaseJwks(Response.json({ keys: [{ ...jwk, kid: "fixture-key", alg: "RS256", use: "sig" }] }));
  const result = await service.waitForAttempt(attempt.id);
  assert.equal(result.status, "failed");

  const saved = store.read()?.accounts[0];
  assert.equal(saved?.usageEnabled, false);
  assert.equal("accessToken" in (saved ?? {}), false);
  assert.equal("refreshToken" in (saved ?? {}), false);
});

test("invalid refresh grant fences a pending reauthorization", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-invalid-grant-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
  const account = {
    id: "account-fixture",
    clientId: "oaiapp-fixture",
    subject: "subject-fixture",
    scopes: scope.split(" "),
    usageEnabled: true,
    accessToken: "expired-access-fixture",
    refreshToken: "invalid-refresh-fixture",
    expiresAt: Date.now() - 1,
  };
  await store.update(state => ({ state: { ...state, accounts: [account] }, result: undefined }));
  let issuedToken = "";
  let releaseJwks!: (response: Response) => void;
  let markJwksRequested!: () => void;
  const jwksRequested = new Promise<void>(resolve => { markJwksRequested = resolve; });
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url === "https://auth.openai.com/api/accounts/oauth/token")
      return Response.json({
        access_token: "reauth-access-fixture",
        refresh_token: "reauth-refresh-fixture",
        id_token: issuedToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
    if (url === "https://auth.openai.com/.well-known/openid-configuration")
      return Response.json({
        issuer: "https://auth.openai.com",
        jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
        token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
      });
    if (url === "https://auth.openai.com/.well-known/jwks.json") {
      markJwksRequested();
      return await new Promise<Response>(resolve => { releaseJwks = resolve; });
    }
    assert.fail(`Unexpected fixture URL: ${url}`);
  };
  const service = new OpenAIChatGPTAuthService({ store, fetcher, agentNameHint: "NOMO" });
  const attempt = await service.beginSignIn({ accountId: account.id });
  t.after(() => {
    service.cancelAttempt(attempt.id);
    if (releaseJwks) releaseJwks(Response.json({ keys: [{ ...jwk, kid: "fixture-key", alg: "RS256", use: "sig" }] }));
  });
  const authorization = new URL(attempt.authorizationUrl);
  issuedToken = signedIdToken({
    iss: "https://auth.openai.com",
    aud: account.clientId,
    sub: account.subject,
    nonce: authorization.searchParams.get("nonce"),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "reauth-code-fixture");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  assert.equal((await fetch(callback)).status, 200);
  await jwksRequested;

  const refreshService = new OpenAIChatGPTAuthService({
    store: new OpenAIChatGPTAuthStore(join(directory, "host-auth")),
    fetcher: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    agentNameHint: "NOMO",
  });
  await assert.rejects(
    refreshService.accessToken(account.id),
    error => error instanceof OpenAIChatGPTAuthError && error.code === "reauth_required",
  );
  releaseJwks(Response.json({ keys: [{ ...jwk, kid: "fixture-key", alg: "RS256", use: "sig" }] }));
  assert.equal((await service.waitForAttempt(attempt.id)).status, "failed");
  const saved = store.read()?.accounts[0];
  assert.equal(saved?.reauthRequired, true);
  assert.equal(saved?.usageEnabled, false);
  assert.equal(saved?.credentialGeneration, 1);
  assert.equal("accessToken" in (saved ?? {}), false);
  assert.equal("refreshToken" in (saved ?? {}), false);
});

test("disconnect from another service fences a pending reauthorization token exchange", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-disconnect-exchange-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
  const account = {
    id: "account-fixture",
    clientId: "oaiapp-fixture",
    subject: "subject-fixture",
    scopes: scope.split(" "),
    usageEnabled: true,
    accessToken: "existing-access-fixture",
    refreshToken: "existing-refresh-fixture",
    expiresAt: Date.now() + 3_600_000,
  };
  await store.update(state => ({ state: { ...state, accounts: [account] }, result: undefined }));
  let issuedToken = "";
  let releaseExchange!: (response: Response) => void;
  let markExchangeStarted!: () => void;
  const exchangeStarted = new Promise<void>(resolve => { markExchangeStarted = resolve; });
  let releaseJwks!: (response: Response) => void;
  let markJwksRequested!: () => void;
  const jwksRequested = new Promise<void>(resolve => { markJwksRequested = resolve; });
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url === "https://auth.openai.com/api/accounts/oauth/token") {
      markExchangeStarted();
      return await new Promise<Response>(resolve => { releaseExchange = resolve; });
    }
    if (url === "https://auth.openai.com/.well-known/openid-configuration")
      return Response.json({
        issuer: "https://auth.openai.com",
        jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
        token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
        revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke",
      });
    if (url === "https://auth.openai.com/.well-known/jwks.json") {
      markJwksRequested();
      return await new Promise<Response>(resolve => { releaseJwks = resolve; });
    }
    if (url === "https://auth.openai.com/api/accounts/oauth/revoke")
      return new Response(null, { status: 200 });
    assert.fail(`Unexpected fixture URL: ${url}`);
  };
  const service = new OpenAIChatGPTAuthService({ store, fetcher, agentNameHint: "NOMO" });
  const attempt = await service.beginSignIn({ accountId: account.id });
  t.after(() => {
    service.cancelAttempt(attempt.id);
    if (releaseExchange) releaseExchange(Response.json({}));
    if (releaseJwks) releaseJwks(Response.json({ keys: [{ ...jwk, kid: "fixture-key", alg: "RS256", use: "sig" }] }));
  });
  const authorization = new URL(attempt.authorizationUrl);
  issuedToken = signedIdToken({
    iss: "https://auth.openai.com",
    aud: account.clientId,
    sub: account.subject,
    nonce: authorization.searchParams.get("nonce"),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "reauth-code-fixture");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  assert.equal((await fetch(callback)).status, 200);
  await exchangeStarted;

  const disconnectingService = new OpenAIChatGPTAuthService({
    store: new OpenAIChatGPTAuthStore(join(directory, "host-auth")),
    fetcher,
    agentNameHint: "NOMO",
  });
  assert.equal((await disconnectingService.disconnect(account.id)).remoteRevocationConfirmed, true);
  releaseExchange(Response.json({
    access_token: "reauth-access-fixture",
    refresh_token: "reauth-refresh-fixture",
    id_token: issuedToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope,
  }));
  await jwksRequested;
  releaseJwks(Response.json({ keys: [{ ...jwk, kid: "fixture-key", alg: "RS256", use: "sig" }] }));
  const signedIn = await service.waitForAttempt(attempt.id);
  assert.equal(signedIn.status, "failed");
  const saved = store.read()?.accounts[0];
  assert.equal(saved?.usageEnabled, false);
  assert.equal(saved?.reauthRequired, false);
  assert.equal("accessToken" in (saved ?? {}), false);
  assert.equal("refreshToken" in (saved ?? {}), false);
});

test("sign-in failures retain only safe provider status, code, and request ID", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-error-details-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
  let tokenFailure = 0;
  let verifierEcho = "";
  const service = new OpenAIChatGPTAuthService({
    store,
    agentNameHint: "NOMO",
    fetcher: async (input, init) => {
      if (String(input) === "https://auth.openai.com/api/accounts/oauth/token") {
        tokenFailure++;
        if (tokenFailure === 1) {
          return Response.json(
            { error: "temporarily_unavailable", error_description: "refresh-fixture-secret" },
            { status: 503, headers: { "x-request-id": "req_fixture-503" } },
          );
        }
        if (tokenFailure === 2) {
          return Response.json(
            { error: "Bearer refresh-fixture-secret", error_description: "refresh-fixture-secret" },
            { status: 502, headers: { "x-request-id": "refresh-fixture-secret" } },
          );
        }
        if (tokenFailure === 3) {
          verifierEcho = new URLSearchParams(String(init?.body)).get("code_verifier")!;
          return Response.json(
            { error: verifierEcho, error_description: verifierEcho },
            { status: 502, headers: { "x-request-id": verifierEcho } },
          );
        }
        return new Response("upstream failure with private content", {
          status: 502,
          headers: { "x-request-id": "req_non_json" },
        });
      }
      assert.fail(`Unexpected fixture URL: ${String(input)}`);
    },
  });
  const attempt = await service.beginSignIn();
  t.after(() => service.cancelAttempt(attempt.id));
  const authorization = new URL(attempt.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "failed-code-fixture");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("client_id", "oaiapp-issued-fixture");
  assert.equal((await fetch(callback)).status, 200);
  const result = await service.waitForAttempt(attempt.id);
  assert.equal(result.status, "failed");
  assert.equal(result.httpStatus, 503);
  assert.equal(result.providerErrorCode, "temporarily_unavailable");
  assert.equal(result.requestId, "req_fixture-503");
  assert.equal(JSON.stringify(result).includes("refresh-fixture-secret"), false);

  const unsafeAttempt = await service.beginSignIn();
  t.after(() => service.cancelAttempt(unsafeAttempt.id));
  const unsafeAuthorization = new URL(unsafeAttempt.authorizationUrl);
  const unsafeCallback = new URL(unsafeAuthorization.searchParams.get("redirect_uri")!);
  unsafeCallback.searchParams.set("code", "refresh-fixture-secret");
  unsafeCallback.searchParams.set("state", unsafeAuthorization.searchParams.get("state")!);
  unsafeCallback.searchParams.set("client_id", "oaiapp-issued-fixture");
  assert.equal((await fetch(unsafeCallback)).status, 200);
  const unsafeResult = await service.waitForAttempt(unsafeAttempt.id);
  assert.equal(unsafeResult.httpStatus, 502);
  assert.equal(unsafeResult.providerErrorCode, undefined);
  assert.equal(unsafeResult.requestId, undefined);
  assert.equal(JSON.stringify(unsafeResult).includes("refresh-fixture-secret"), false);

  const verifierAttempt = await service.beginSignIn();
  t.after(() => service.cancelAttempt(verifierAttempt.id));
  const verifierAuthorization = new URL(verifierAttempt.authorizationUrl);
  const verifierCallback = new URL(verifierAuthorization.searchParams.get("redirect_uri")!);
  verifierCallback.searchParams.set("code", "safe-code-fixture");
  verifierCallback.searchParams.set("state", verifierAuthorization.searchParams.get("state")!);
  verifierCallback.searchParams.set("client_id", "oaiapp-issued-fixture");
  assert.equal((await fetch(verifierCallback)).status, 200);
  const verifierResult = await service.waitForAttempt(verifierAttempt.id);
  assert.equal(verifierResult.httpStatus, 502);
  assert.equal(verifierResult.providerErrorCode, undefined);
  assert.equal(verifierResult.requestId, undefined);
  assert.equal(verifierEcho.length > 40, true);
  assert.equal(JSON.stringify(verifierResult).includes(verifierEcho), false);

  const malformedAttempt = await service.beginSignIn();
  t.after(() => service.cancelAttempt(malformedAttempt.id));
  const malformedAuthorization = new URL(malformedAttempt.authorizationUrl);
  const malformedCallback = new URL(malformedAuthorization.searchParams.get("redirect_uri")!);
  malformedCallback.searchParams.set("code", "malformed-body-code");
  malformedCallback.searchParams.set("state", malformedAuthorization.searchParams.get("state")!);
  malformedCallback.searchParams.set("client_id", "oaiapp-issued-fixture");
  assert.equal((await fetch(malformedCallback)).status, 200);
  const malformedResult = await service.waitForAttempt(malformedAttempt.id);
  assert.equal(malformedResult.status, "failed");
  assert.equal(malformedResult.httpStatus, 502);
  assert.equal(malformedResult.providerErrorCode, undefined);
  assert.equal(malformedResult.requestId, "req_non_json");
  assert.equal(JSON.stringify(malformedResult).includes("upstream failure"), false);
});

test("invalid ID-token signatures and claims never save account credentials", async t => {
  const cases: Array<{
    label: string;
    alterToken(token: string, claims: Record<string, unknown>): string;
  }> = [
    { label: "signature", alterToken: token => token.slice(0, token.lastIndexOf(".")) + "." + Buffer.alloc(256).toString("base64url") },
    { label: "issuer", alterToken: (_token, claims) => signedIdToken({ ...claims, iss: "https://wrong.invalid" }) },
    { label: "audience", alterToken: (_token, claims) => signedIdToken({ ...claims, aud: "other-client" }) },
    { label: "nonce", alterToken: (_token, claims) => signedIdToken({ ...claims, nonce: "wrong-nonce" }) },
    { label: "expiration", alterToken: (_token, claims) => signedIdToken({ ...claims, exp: Math.floor(Date.now() / 1000) - 3600 }) },
  ];

  for (const { label, alterToken } of cases) {
    const directory = await mkdtemp(join(tmpdir(), `nomo-siwc-invalid-id-token-${label}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
    let idToken = "";
    const clientId = "oaiapp-issued-fixture";
    const service = new OpenAIChatGPTAuthService({
      store,
      agentNameHint: "NOMO",
      fetcher: async input => {
        const url = String(input);
        if (url === "https://auth.openai.com/api/accounts/oauth/token")
          return Response.json({
            access_token: "invalid-claim-access-fixture",
            refresh_token: "invalid-claim-refresh-fixture",
            id_token: idToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope,
          });
        if (url === "https://auth.openai.com/.well-known/openid-configuration")
          return Response.json({
            issuer: "https://auth.openai.com",
            jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
            token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
          });
        if (url === "https://auth.openai.com/.well-known/jwks.json")
          return Response.json({ keys: [{ ...jwk, kid: "fixture-key", alg: "RS256", use: "sig" }] });
        assert.fail(`Unexpected fixture URL: ${url}`);
      },
    });
    const attempt = await service.beginSignIn();
    t.after(() => service.cancelAttempt(attempt.id));
    const authorization = new URL(attempt.authorizationUrl);
    const claims = {
      iss: "https://auth.openai.com",
      aud: clientId,
      sub: `subject-${label}`,
      nonce: authorization.searchParams.get("nonce"),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const validToken = signedIdToken(claims);
    idToken = alterToken(validToken, claims);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", `invalid-id-token-${label}`);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("client_id", clientId);
    assert.equal((await fetch(callback)).status, 200);
    const result = await service.waitForAttempt(attempt.id);
    assert.equal(result.status, "failed", label);
    assert.equal(result.errorCode, "authorization_failed", label);
    assert.equal(store.read()?.accounts.length, 0, label);
  }
});

test("canceled sign-in does not leak the PKCE verifier in status", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-cancel-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new OpenAIChatGPTAuthService({
    store: new OpenAIChatGPTAuthStore(join(directory, "host-auth")),
    agentNameHint: "NOMO",
    fetcher: async input => {
      if (String(input) === "https://auth.openai.com/api/accounts/oauth/token")
        return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      assert.fail(`Unexpected fixture URL: ${String(input)}`);
    },
  });
  const attempt = await service.beginSignIn();
  const authorization = new URL(attempt.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "failed-code-fixture");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("client_id", "oaiapp-issued-fixture");
  assert.equal((await fetch(callback)).status, 200);
  const result = await service.waitForAttempt(attempt.id);
  assert.equal(result.status, "failed");
  assert.equal(JSON.stringify(result).includes("code_verifier="), false);
  assert.ok(result.httpStatus);
  assert.equal(result.providerErrorCode, "temporarily_unavailable");
});

test("canceling sign-in aborts an in-flight token exchange", async t => {
  const directory = await mkdtemp(join(tmpdir(), "nomo-siwc-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OpenAIChatGPTAuthStore(join(directory, "host-auth"));
  let resolveExchange!: (response: Response) => void;
  let markExchangeStarted!: () => void;
  const exchangeStarted = new Promise<void>(resolve => { markExchangeStarted = resolve; });
  let exchangeSignal: AbortSignal | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) !== "https://auth.openai.com/api/accounts/oauth/token")
      assert.fail(`Unexpected fixture URL: ${String(input)}`);
    exchangeSignal = init?.signal as AbortSignal | undefined;
    return await new Promise<Response>(resolve => {
      resolveExchange = resolve;
      markExchangeStarted();
    });
  };
  const service = new OpenAIChatGPTAuthService({ store, fetcher, agentNameHint: "NOMO" });
  const attempt = await service.beginSignIn();
  const authorization = new URL(attempt.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "cancelled-code");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("client_id", "oaiapp_fixture");
  assert.equal((await fetch(callback)).status, 200);
  await exchangeStarted;

  try {
    service.cancelAttempt(attempt.id);
    assert.equal(exchangeSignal?.aborted, true);
  } finally {
    resolveExchange(Response.json({ error: "cancelled" }, { status: 400 }));
  }
  await new Promise<void>(resolve => setImmediate(resolve));
});

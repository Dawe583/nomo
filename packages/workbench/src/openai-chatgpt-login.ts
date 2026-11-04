import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  buildOpenAIChatGPTAuthorizeUrl,
  type OpenAIChatGPTAccount,
  type OpenAIChatGPTAuthStore,
  type OpenAIChatGPTAuthState,
} from "./openai-chatgpt-auth.ts";

const RESOURCE = "https://api.openai.com/v1";
const TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
const OIDC_CONFIGURATION = "https://auth.openai.com/.well-known/openid-configuration";
const AUTH_TIMEOUT_MS = 5 * 60_000;

type AttemptStatus = "pending" | "connected" | "usage-disabled" | "declined" | "failed";
export type OpenAIChatGPTAuthAttemptView = {
  readonly id: string;
  readonly status: AttemptStatus;
  readonly accountId?: string;
  readonly email?: string;
  readonly usageEnabled?: boolean;
  readonly errorCode?: string;
  readonly httpStatus?: number;
  readonly providerErrorCode?: string;
  readonly requestId?: string;
};
export type OpenAIChatGPTAuthAttempt = {
  readonly id: string;
  readonly authorizationUrl: string;
};
export type OpenAIChatGPTAccountSummary = {
  readonly id: string;
  readonly email?: string;
  readonly status: "connected" | "usage-disabled" | "signed-out" | "reauth-required";
  readonly usageEnabled: boolean;
  readonly scopes: readonly string[];
  readonly active: boolean;
};

export class OpenAIChatGPTAuthError extends Error {
  readonly code: string;
  readonly httpStatus?: number;
  readonly providerErrorCode?: string;
  readonly requestId?: string;

  constructor(code: string, diagnostics: {
    readonly httpStatus?: number;
    readonly providerErrorCode?: string;
    readonly requestId?: string;
  } = {}) {
    super(code === "reauth_required"
      ? "OpenAI account needs sign-in again."
      : "OpenAI account cannot use ChatGPT plan inference.");
    this.code = code;
    this.httpStatus = diagnostics.httpStatus;
    this.providerErrorCode = diagnostics.providerErrorCode;
    this.requestId = diagnostics.requestId;
  }
}
type AttemptRecord = {
  readonly view: OpenAIChatGPTAuthAttemptView;
  readonly server: Server;
  readonly redirectUri: string;
  readonly clientId?: string;
  readonly accountId?: string;
  readonly subject?: string;
  readonly credentialGeneration?: number;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly promise: Promise<OpenAIChatGPTAuthAttemptView>;
  readonly abortController: AbortController;
  resolve(view: OpenAIChatGPTAuthAttemptView): void;
  timer?: NodeJS.Timeout;
  processing: boolean;
};
type OidcConfiguration = {
  readonly issuer?: unknown;
  readonly jwks_uri?: unknown;
  readonly token_endpoint?: unknown;
};
type TokenResponse = {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly id_token?: unknown;
  readonly token_type?: unknown;
  readonly expires_in?: unknown;
  readonly scope?: unknown;
};

/** Owns one-shot loopback authorization attempts and their validated results. */
export class OpenAIChatGPTAuthService {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly options: {
    readonly store: OpenAIChatGPTAuthStore;
    readonly fetcher?: typeof fetch;
    readonly agentNameHint: string;
  };

  constructor(options: {
    readonly store: OpenAIChatGPTAuthStore;
    readonly fetcher?: typeof fetch;
    readonly agentNameHint: string;
  }) {
    this.options = options;
  }

  async beginSignIn(input: { accountId?: string; enablePlanUsage?: boolean } = {}): Promise<OpenAIChatGPTAuthAttempt> {
    if ([...this.attempts.values()].some(attempt => attempt.view.status === "pending"))
      throw new Error("Another OpenAI sign-in is already pending.");
    let state: OpenAIChatGPTAuthState | undefined;
    await this.options.store.update(current => {
      state = current;
      return { state: current, result: undefined };
    });
    const selected = input.accountId
      ? state?.accounts.find(account => account.id === input.accountId)
      : undefined;
    if (input.accountId && !selected) throw new Error("OpenAI account is unavailable.");
    if (input.enablePlanUsage && !selected)
      throw new Error("Choose a saved OpenAI account before enabling plan usage.");

    const authState = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("OpenAI callback listener is unavailable.");
    }
    const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const authorizationUrl = buildOpenAIChatGPTAuthorizeUrl({
      hostId: state!.hostId,
      redirectUri,
      state: authState,
      nonce,
      codeChallenge: challenge,
      ...(selected ? { clientId: selected.clientId } : { agentNameHint: this.options.agentNameHint }),
      ...(input.enablePlanUsage ? { promptConsent: true } : {}),
    });
    const id = randomUUID();
    let resolve!: (view: OpenAIChatGPTAuthAttemptView) => void;
    const promise = new Promise<OpenAIChatGPTAuthAttemptView>(done => { resolve = done; });
    const record: AttemptRecord = {
      view: { id, status: "pending" },
      server,
      redirectUri,
      ...(selected ? {
        clientId: selected.clientId,
        accountId: selected.id,
        subject: selected.subject,
        credentialGeneration: selected.credentialGeneration ?? 0,
      } : {}),
      state: authState,
      nonce,
      verifier,
      promise,
      resolve,
      abortController: new AbortController(),
      processing: false,
    };
    this.attempts.set(id, record);
    this.attachCallback(record);
    record.timer = setTimeout(() => this.finish(record, { id, status: "failed", errorCode: "authorization_timeout" }), AUTH_TIMEOUT_MS);
    record.timer.unref();
    return { id, authorizationUrl: authorizationUrl.toString() };
  }

  attempt(id: string): OpenAIChatGPTAuthAttemptView | undefined {
    return this.attempts.get(id)?.view;
  }

  cancelAttempt(id: string): OpenAIChatGPTAuthAttemptView | undefined {
    const record = this.attempts.get(id);
    if (!record) return undefined;
    this.finish(record, { id, status: "failed", errorCode: "browser_launch_failed" });
    return record.view;
  }

  accounts(activeAccountId?: string): readonly OpenAIChatGPTAccountSummary[] {
    return (this.options.store.read()?.accounts ?? []).map(account => {
      const hasTokens = !!account.accessToken;
      const expiredWithoutRefresh = !!account.expiresAt && account.expiresAt <= Date.now() && !account.refreshToken;
      const status = account.reauthRequired || expiredWithoutRefresh
        ? "reauth-required"
        : account.usageEnabled && hasTokens
          ? "connected"
          : account.scopes.includes("chatgpt.tokens.use.direct")
            ? "signed-out"
            : "usage-disabled";
      return {
        id: account.id,
        ...(account.email ? { email: account.email } : {}),
        status,
        usageEnabled: status === "connected",
        scopes: [...account.scopes],
        active: account.id === activeAccountId,
      };
    });
  }

  async accessToken(accountId: string): Promise<string> {
    let outcome: { readonly token?: string; readonly errorCode?: string } = {};
    await this.options.store.update(async state => {
      const account = state.accounts.find(item => item.id === accountId);
      if (!account?.usageEnabled || !account.accessToken || !account.expiresAt)
        throw new OpenAIChatGPTAuthError(account?.reauthRequired ? "reauth_required" : "usage_disabled");
      const now = Date.now();
      if (account.expiresAt > now + 60_000 || (!account.refreshToken && account.expiresAt > now)) {
        outcome = { token: account.accessToken };
        return { state, result: undefined };
      }
      if (!account.refreshToken) {
        outcome = { errorCode: "reauth_required" };
        return { state: replaceAccount(state, withoutTokens(account, true)), result: undefined };
      }
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: account.clientId,
        refresh_token: account.refreshToken,
        resource: RESOURCE,
      });
      let refreshed: Awaited<ReturnType<typeof fetchJson>>;
      try {
        refreshed = await fetchJson(this.options.fetcher ?? fetch, TOKEN_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: form,
        });
      } catch {
        throw new OpenAIChatGPTAuthError("refresh_failed");
      }
      if (!refreshed.response.ok) {
        const secrets = [account.accessToken, account.refreshToken];
        const providerErrorCode = safeDiagnosticField(oauthErrorCode(refreshed.value), secrets);
        const requestId = safeDiagnosticField(refreshed.response.headers.get("x-request-id"), secrets);
        const diagnostics = {
          httpStatus: refreshed.response.status,
          ...(providerErrorCode ? { providerErrorCode } : {}),
          ...(requestId ? { requestId } : {}),
        };
        if (isInvalidRefreshCode(providerErrorCode)) {
          outcome = { errorCode: "reauth_required" };
          return { state: replaceAccount(state, withoutTokens(account, true)), result: undefined };
        }
        throw new OpenAIChatGPTAuthError("refresh_failed", diagnostics);
      }
      const token = refreshed.value as TokenResponse;
      if (
        token.token_type !== "Bearer" || typeof token.access_token !== "string" || !token.access_token ||
        typeof token.refresh_token !== "string" || !token.refresh_token ||
        typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) ||
        token.expires_in <= 0 || token.expires_in > 31_536_000 ||
        (token.scope !== undefined && typeof token.scope !== "string")
      ) throw new OpenAIChatGPTAuthError("refresh_failed");
      const scopes = typeof token.scope === "string"
        ? [...new Set(token.scope.split(/\s+/).filter(Boolean))]
        : [...account.scopes];
      const usageEnabled = scopes.includes("resource.invoke") &&
        scopes.includes("chatgpt.tokens.use.direct");
      const updated: OpenAIChatGPTAccount = {
        ...account,
        scopes,
        usageEnabled,
        reauthRequired: false,
        credentialGeneration: (account.credentialGeneration ?? 0) + 1,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: now + token.expires_in * 1000,
      };
      if (!usageEnabled) {
        outcome = { errorCode: "usage_disabled" };
        return { state: replaceAccount(state, withoutTokens(updated, false)), result: undefined };
      }
      outcome = { token: updated.accessToken };
      return { state: replaceAccount(state, updated), result: undefined };
    });
    if (outcome.errorCode) throw new OpenAIChatGPTAuthError(outcome.errorCode);
    if (!outcome.token) throw new OpenAIChatGPTAuthError("reauth_required");
    return outcome.token;
  }

  async disconnect(accountId: string): Promise<{
    readonly accountId: string;
    readonly remoteRevocationConfirmed: boolean;
  }> {
    return this.options.store.update(async state => {
      const account = state.accounts.find(item => item.id === accountId);
      if (!account) throw new OpenAIChatGPTAuthError("account_not_found");
      for (const attempt of this.attempts.values()) {
        if (attempt.accountId === accountId && attempt.view.status === "pending")
          this.finish(attempt, { id: attempt.view.id, status: "failed", errorCode: "account_disconnected" });
      }
      let remoteRevocationConfirmed = false;
      if (account.refreshToken) {
        try {
          const fetcher = this.options.fetcher ?? fetch;
          const metadata = await fetchJson(fetcher, OIDC_CONFIGURATION);
          const config = metadata.value as OidcConfiguration & { revocation_endpoint?: unknown };
          if (!metadata.response.ok || config.issuer !== "https://auth.openai.com" ||
            typeof config.revocation_endpoint !== "string") throw new Error("Revocation endpoint is unavailable.");
          const endpoint = new URL(config.revocation_endpoint);
          if (endpoint.protocol !== "https:" || endpoint.hostname !== "auth.openai.com" ||
            endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
            throw new Error("Revocation endpoint is invalid.");
          const form = new URLSearchParams({
            token: account.refreshToken,
            token_type_hint: "refresh_token",
            client_id: account.clientId,
          });
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const response = await fetcher(endpoint, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: form,
                redirect: "error",
                signal: AbortSignal.timeout(15_000),
              });
              if (response.status === 200) {
                await response.body?.cancel().catch(() => {});
                remoteRevocationConfirmed = true;
                break;
              }
              await response.body?.cancel().catch(() => {});
              if (response.status < 500 || attempt === 2) break;
            } catch {
              if (attempt === 2) break;
            }
            await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
          }
        } catch {
          remoteRevocationConfirmed = false;
        }
      }
      const {
        accessToken: _accessToken,
        refreshToken: _refreshToken,
        expiresAt: _expiresAt,
        ...registration
      } = account;
      const disconnected: OpenAIChatGPTAccount = {
        ...registration,
        usageEnabled: false,
        reauthRequired: false,
        credentialGeneration: (account.credentialGeneration ?? 0) + 1,
      };
      const nextState = replaceAccount(state, disconnected);
      return {
        state: nextState,
        result: { accountId, remoteRevocationConfirmed },
      };
    });
  }

  waitForAttempt(id: string): Promise<OpenAIChatGPTAuthAttemptView> {
    const attempt = this.attempts.get(id);
    return attempt ? attempt.promise : Promise.reject(new Error("OpenAI sign-in attempt not found."));
  }

  private attachCallback(record: AttemptRecord): void {
    record.server.on("request", (request, response) => {
      const address = record.server.address();
      const expectedHost = address && typeof address !== "string"
        ? `127.0.0.1:${address.port}`
        : "";
      if (
        request.method !== "GET" || request.headers.host !== expectedHost ||
        !request.url || request.url.length > 8192
      ) {
        respond(response, 404, "This sign-in callback is unavailable.");
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url, record.redirectUri);
      } catch {
        respond(response, 400, "This sign-in response is invalid.");
        return;
      }
      if (url.origin !== new URL(record.redirectUri).origin) {
        respond(response, 400, "This sign-in response is invalid.");
        return;
      }
      if (url.pathname !== "/auth/callback") {
        respond(response, 404, "This sign-in callback is unavailable.");
        return;
      }
      if (["state", "code", "client_id", "error"].some(key => url.searchParams.getAll(key).length > 1)) {
        respond(response, 400, "This sign-in response is invalid.");
        return;
      }
      const state = oneQueryValue(url, "state");
      if (!state || state !== record.state) {
        respond(response, 400, "This sign-in response is invalid.");
        return;
      }
      if (record.processing) {
        respond(response, 409, "This sign-in response was already received.");
        return;
      }
      record.processing = true;
      const oauthError = oneQueryValue(url, "error");
      if (oauthError && oneQueryValue(url, "code")) {
        respond(response, 400, "This sign-in response is invalid.");
        record.processing = false;
        return;
      }
      if (oauthError) {
        respond(response, 200, "Sign-in was not completed. Return to NOMO.");
        this.finish(record, {
          id: record.view.id,
          status: oauthError === "access_denied" ? "declined" : "failed",
          ...(oauthError === "access_denied" ? {} : { errorCode: "authorization_error" }),
        });
        return;
      }
      const code = oneQueryValue(url, "code");
      const callbackClientId = oneQueryValue(url, "client_id");
      if (!code || code.length > 4096 ||
        (!record.clientId && (!callbackClientId || callbackClientId === "dynamic_agent_client")) ||
        (record.clientId && callbackClientId && callbackClientId !== record.clientId)) {
        respond(response, 400, "This sign-in response is invalid.");
        record.processing = false;
        return;
      }
      respond(response, 200, "Sign-in response received. Return to NOMO.");
      void this.exchangeAndSave(record, code, callbackClientId)
        .then(view => this.finish(record, view))
        .catch(error => this.finish(record, {
          id: record.view.id,
          status: "failed",
          errorCode: error instanceof OpenAIChatGPTAuthError ? error.code : "authorization_failed",
          ...(error instanceof OpenAIChatGPTAuthError && error.httpStatus !== undefined
            ? { httpStatus: error.httpStatus }
            : {}),
          ...(error instanceof OpenAIChatGPTAuthError && error.providerErrorCode
            ? { providerErrorCode: error.providerErrorCode }
            : {}),
          ...(error instanceof OpenAIChatGPTAuthError && error.requestId ? { requestId: error.requestId } : {}),
        }));
    });
  }

  private async exchangeAndSave(
    record: AttemptRecord,
    code: string,
    callbackClientId: string | null,
  ): Promise<OpenAIChatGPTAuthAttemptView> {
    const clientId = record.clientId ?? callbackClientId;
    if (!clientId || clientId === "dynamic_agent_client")
      throw new Error("Issued client ID is missing.");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: record.verifier,
      redirect_uri: record.redirectUri,
      resource: RESOURCE,
    });
    const tokenResult = await fetchJson(
      this.options.fetcher ?? fetch,
      TOKEN_ENDPOINT,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: record.abortController.signal,
      },
    );
    if (!tokenResult.response.ok) {
      throw new OpenAIChatGPTAuthError("authorization_failed", {
        httpStatus: tokenResult.response.status,
        providerErrorCode: safeDiagnosticField(oauthErrorCode(tokenResult.value), [code, record.verifier]),
        requestId: safeDiagnosticField(tokenResult.response.headers.get("x-request-id"), [code, record.verifier]),
      });
    }
    const token = tokenResult.value as TokenResponse;
    if (
      token.token_type !== "Bearer" || typeof token.access_token !== "string" ||
      !token.access_token || token.access_token.length > 16_384 ||
      typeof token.id_token !== "string" || token.id_token.length > 32_768 ||
      typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0 || token.expires_in > 31_536_000 ||
      typeof token.scope !== "string" || token.scope.length > 4096
    ) throw new Error("Token response is invalid.");
    if (token.refresh_token !== undefined &&
      (typeof token.refresh_token !== "string" || !token.refresh_token || token.refresh_token.length > 16_384))
      throw new Error("Token response is invalid.");
    const scopes = [...new Set(token.scope.split(/\s+/).filter(Boolean))];
    const claims = await validateIdToken(
      token.id_token,
      clientId,
      record.nonce,
      this.options.fetcher ?? fetch,
      record.abortController.signal,
    );
    const usageEnabled = scopes.includes("resource.invoke") &&
      scopes.includes("chatgpt.tokens.use.direct");
    const existingId = record.accountId ?? randomUUID();
    const account: OpenAIChatGPTAccount = {
      id: existingId,
      clientId,
      subject: claims.sub,
      ...(claims.email ? { email: claims.email } : {}),
      scopes,
      usageEnabled,
      credentialGeneration: (record.credentialGeneration ?? 0) + 1,
      ...(usageEnabled ? {
        accessToken: token.access_token,
        ...(typeof token.refresh_token === "string" ? { refreshToken: token.refresh_token } : {}),
        expiresAt: Date.now() + token.expires_in * 1000,
      } : {}),
    };
    let savedId = existingId;
    await this.options.store.update(state => {
      if (record.view.status !== "pending")
        throw new Error("OpenAI sign-in attempt is no longer active.");
      const selected = record.accountId
        ? state.accounts.find(item => item.id === record.accountId)
        : state.accounts.find(item => item.clientId === clientId);
      if (record.accountId && (!selected || selected.clientId !== clientId || selected.subject !== record.subject))
        throw new Error("Selected OpenAI account changed during sign-in.");
      if (selected && selected.subject !== claims.sub)
        throw new Error("OpenAI account identity changed.");
      if (selected && (selected.credentialGeneration ?? 0) !== (record.credentialGeneration ?? 0))
        throw new Error("OpenAI account changed during sign-in.");
      if (selected) savedId = selected.id;
      const savedAccount = savedId === account.id ? account : { ...account, id: savedId };
      const accounts = selected
        ? state.accounts.map(item => item.id === savedId ? savedAccount : item)
        : [...state.accounts, savedAccount];
      return { state: { ...state, accounts }, result: undefined };
    });
    return {
      id: record.view.id,
      status: usageEnabled ? "connected" : "usage-disabled",
      accountId: savedId,
      ...(claims.email ? { email: claims.email } : {}),
      usageEnabled,
    };
  }

  private finish(record: AttemptRecord, view: OpenAIChatGPTAuthAttemptView): void {
    if (record.view.status !== "pending") return;
    Object.assign(record.view, view);
    if (view.status !== "connected" && view.status !== "usage-disabled")
      record.abortController.abort();
    if (record.timer) clearTimeout(record.timer);
    record.server.close();
    record.resolve(record.view);
  }
}

type VerifiedClaims = { readonly sub: string; readonly email?: string };

async function validateIdToken(
  token: string,
  clientId: string,
  nonce: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<VerifiedClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)))
    throw new Error("ID token is invalid.");
  const header = decodeJsonPart(parts[0]!);
  const claims = decodeJsonPart(parts[1]!);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid)
    throw new Error("ID token algorithm is invalid.");

  const metadataResult = await fetchJson(fetcher, OIDC_CONFIGURATION, { signal });
  const metadata = metadataResult.value as OidcConfiguration;
  if (
    !metadataResult.response.ok || metadata.issuer !== "https://auth.openai.com" ||
    metadata.token_endpoint !== TOKEN_ENDPOINT || typeof metadata.jwks_uri !== "string"
  ) throw new Error("OpenID configuration is invalid.");
  const jwksUri = new URL(metadata.jwks_uri);
  if (jwksUri.protocol !== "https:" || jwksUri.hostname !== "auth.openai.com" ||
    jwksUri.username || jwksUri.password || jwksUri.search || jwksUri.hash)
    throw new Error("OpenID key endpoint is invalid.");
  const keysResult = await fetchJson(fetcher, jwksUri.toString(), { signal });
  const keys = (keysResult.value as { keys?: unknown }).keys;
  if (!keysResult.response.ok || !Array.isArray(keys)) throw new Error("OpenID keys are invalid.");
  const key = keys.find((value): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value) &&
    value.kid === header.kid && value.kty === "RSA" &&
    (value.use === undefined || value.use === "sig") &&
    (value.alg === undefined || value.alg === "RS256") &&
    (value.key_ops === undefined || (Array.isArray(value.key_ops) && value.key_ops.includes("verify")))
  );
  if (!key) throw new Error("ID token signing key is unavailable.");
  const publicKey = createPublicKey({
    key: key as unknown as { kty: "RSA"; n: string; e: string },
    format: "jwk",
  });
  if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, "base64url")))
    throw new Error("ID token signature is invalid.");

  const now = Math.floor(Date.now() / 1000);
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (
    claims.iss !== "https://auth.openai.com" ||
    !Array.isArray(audiences) || !audiences.includes(clientId) ||
    (audiences.length > 1 && claims.azp !== clientId) ||
    (claims.azp !== undefined && claims.azp !== clientId) ||
    claims.nonce !== nonce || typeof claims.sub !== "string" || !claims.sub ||
    typeof claims.exp !== "number" || claims.exp <= now - 60 ||
    typeof claims.iat !== "number" || claims.iat > now + 60 ||
    (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 60))
  ) throw new Error("ID token claims are invalid.");
  return {
    sub: claims.sub,
    ...(claims.email_verified === true && typeof claims.email === "string" && claims.email
      ? { email: claims.email }
      : {}),
  };
}

function safeDiagnosticField(value: unknown, secrets: string | readonly string[] = []): string | undefined {
  const blocked = typeof secrets === "string" ? [secrets] : secrets;
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) &&
    blocked.every(secret => !secret || !value.includes(secret)) ? value : undefined;
}

function decodeJsonPart(part: string): Record<string, unknown> {
  if (part.length > 65_536) throw new Error("ID token is too large.");
  const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("ID token JSON is invalid.");
  return parsed as Record<string, unknown>;
}

async function fetchJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<{ response: Response; value: unknown }> {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("OpenAI response is too large.");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    if (response.ok) throw new Error("OpenAI response is invalid.");
    value = undefined;
  }
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    if (response.ok) throw new Error("OpenAI response is invalid.");
    value = undefined;
  }
  return { response, value };
}

function withoutTokens(account: OpenAIChatGPTAccount, reauthRequired: boolean): OpenAIChatGPTAccount {
  const {
    accessToken: _accessToken,
    refreshToken: _refreshToken,
    expiresAt: _expiresAt,
    ...registration
  } = account;
  return {
    ...registration,
    usageEnabled: false,
    reauthRequired,
    credentialGeneration: (account.credentialGeneration ?? 0) + 1,
  };
}

function replaceAccount(
  state: OpenAIChatGPTAuthState,
  account: OpenAIChatGPTAccount,
): OpenAIChatGPTAuthState {
  return { ...state, accounts: state.accounts.map(item => item.id === account.id ? account : item) };
}

function oauthErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("error" in value)) return undefined;
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

function isInvalidRefreshCode(code: string | undefined): boolean {
  return [
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
  ].includes(code ?? "");
}

function oneQueryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] ? values[0] : null;
}

function respond(response: import("node:http").ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(message);
}

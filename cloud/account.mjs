/**
 * The account broker for the chat origin, and the only code in this repository
 * that talks to Supabase Auth.
 *
 * This is the same design as `api/_auth.ts` in the marketing repository, and it
 * is the same design on purpose: one person is one person on both origins. The
 * identity is a Supabase user id, the browser never holds a provider key, and
 * the sealed cookie this module writes is the only thing that survives a
 * request.
 *
 * Three properties are load bearing and each one has a test in
 * `cloud/account.test.mjs`.
 *
 * **The provider is server side only.** `vercel.json` sets `default-src 'self'`
 * and `connect-src 'self'`, and nothing here changes that. The browser posts to
 * this origin, this module calls Supabase over TLS, and the answer comes back
 * sealed. Adding the provider origin to the CSP would put a Supabase token in
 * the browser, which is the thing this whole shape exists to prevent.
 *
 * **The cookie is sealed, not merely signed.** A signed cookie is readable by
 * anyone holding it and the payload carries an access token. AES-256-GCM
 * authenticates and encrypts in one pass, so a tampered cookie fails to open
 * instead of decoding into an identity somebody chose.
 *
 * **The provider is asked who the caller is, every time.** Sealing proves the
 * cookie is ours. It does not prove the person holding it is still the person it
 * was issued to, so a resolved session is confirmed against the provider before
 * it becomes an owner.
 *
 * Sign up is off. `signupAllowed()` reads `VOID_ACCOUNT_SIGNUP`, which is not
 * set, and no code path here creates an account unless it is. The gate is in
 * `docs/APPWRITE-AUTH.md` and the conditions that have to hold before it is
 * turned on are listed in `docs/ACCOUNT-OWNERSHIP.md`.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { assertOwner } from "./owner.mjs";

const COOKIE = "__Host-void-account";
export const SESSION_COOKIE = COOKIE;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const FAILURE_STATUS = Object.freeze({
  invalid_credentials: 401,
  invite_required: 403,
  provider_error: 502,
});

const hexKey = (value, name) => {
  const key = Buffer.from(value, "hex");
  if (key.length !== 32)
    throw new Error(`${name} must be 64 hex characters, which is 32 bytes.`);
  return key;
};

/** `iv.tag.ciphertext`, all base64url, because a cookie may not carry `+` or `/`. */
export function sealSession(session, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    hexKey(secret, "VOID_ACCOUNT_SEAL_KEY"),
    iv,
  );
  const body = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), body]
    .map((part) => part.toString("base64url"))
    .join(".");
}

/**
 * The inverse. Anything this module did not seal returns null, and the
 * middleware reads null as "no account here" rather than as an error, because a
 * cookie the visitor edited is not a cookie worth reporting.
 */
export function openSession(value, secret) {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      hexKey(secret, "VOID_ACCOUNT_SEAL_KEY"),
      Buffer.from(parts[0], "base64url"),
    );
    decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
    const parsed = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(parts[2], "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    );
    if (typeof parsed?.userId !== "string") return null;
    if (typeof parsed?.accessToken !== "string") return null;
    if (typeof parsed?.expiresAt !== "number" || parsed.expiresAt <= Date.now())
      return null;
    assertOwner(parsed.userId);
    return parsed;
  } catch {
    return null;
  }
}

export function setSessionCookie(res, sealed) {
  res.setHeader(
    "set-cookie",
    `${COOKIE}=${sealed}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );
}

export function clearSessionCookie(res) {
  res.setHeader(
    "set-cookie",
    `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  );
}

/** The one cookie parser for the account cookie, and it looks at nothing else. */
export function readSessionCookie(req) {
  const header = req.headers?.cookie;
  const raw = Array.isArray(header) ? header.join(";") : header;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/**
 * Public signup is off until `docs/APPWRITE-AUTH.md` says it may be on. It is a
 * named switch rather than a deleted branch so the condition to satisfy is a
 * line of configuration and not an archaeology exercise.
 */
export const signupAllowed = (env = process.env) =>
  env.VOID_ACCOUNT_SIGNUP === "1";

/**
 * Supabase answers 200 for a session and 400 for everything else, with a machine
 * code in the body. Only two of those codes carry information worth passing on,
 * and both become the same sentence so the API never says whether an address is
 * registered.
 */
const classify = (status, body) => {
  if (status === 400 && body?.error_code === "user_already_exists")
    return "invalid_credentials";
  if (status === 422 || status === 400) return "invalid_credentials";
  if (status === 429 || status >= 500) return "provider_error";
  return "invalid_credentials";
};

export function createAccountService(config) {
  const doFetch = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => Date.now());

  async function supabase(path, init = {}) {
    const url = `${String(config.supabaseUrl ?? "").replace(/\/+$/, "")}/auth/v1${path}`;
    const response = await doFetch(url, {
      method: init.method ?? "GET",
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${init.token ?? config.supabaseKey}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  }

  /**
   * The only call that decides who a caller is. It goes to the provider every
   * time, and the answer is an id, never a set of claims.
   */
  async function whoIs(accessToken) {
    if (typeof accessToken !== "string" || !accessToken) return null;
    const result = await supabase("/user", {
      method: "GET",
      token: accessToken,
    });
    if (!result.ok || typeof result.body?.id !== "string") return null;
    return { id: result.body.id, email: result.body.email ?? null };
  }

  const toSession = (user, accessToken, refreshToken) => ({
    userId: user.id,
    email: String(user.email ?? "").toLowerCase(),
    accessToken,
    refreshToken: refreshToken || null,
    expiresAt: now() + SESSION_TTL_MS,
  });

  const service = {
    /**
     * Whether this deployment can issue a session at all. Absent configuration
     * is not a degraded mode: with no provider there is nothing to sign in
     * against, and the middleware refuses rather than inventing an identity.
     */
    isConfigured() {
      return Boolean(
        config.supabaseUrl && config.supabaseKey && config.sessionSecret,
      );
    },

    whoIs,
    openSession: (value) => openSession(value, config.sessionSecret),
    sealSession: (session) => sealSession(session, config.sessionSecret),

    /**
     * Password or magic link. A signup is attempted only when the provider says
     * there is no such account AND signup is switched on AND the request
     * carried an invitation code. With the switch off the answer is
     * `invite_required`, which is the same sentence an uninvited visitor gets
     * and is not an answer about whether the address holds an account.
     */
    async signIn(request) {
      if (!service.isConfigured()) return { failure: "provider_error" };
      if (!request || typeof request !== "object")
        return { failure: "invalid_credentials" };

      if (request.method === "magic_link") {
        const user = await whoIs(request.access_token);
        if (!user) return { failure: "invalid_credentials" };
        return {
          session: toSession(
            user,
            request.access_token,
            request.refresh_token,
          ),
        };
      }

      if (request.method === "magic_link_request") {
        const failure = await service.requestMagicLink(request.email);
        return failure ? { failure } : { session: null };
      }

      if (request.method !== "password")
        return { failure: "invalid_credentials" };
      if (
        typeof request.email !== "string" ||
        !request.email.includes("@") ||
        typeof request.password !== "string" ||
        !request.password
      )
        return { failure: "invalid_credentials" };

      const attempt = await supabase("/token?grant_type=password", {
        method: "POST",
        body: { email: request.email, password: request.password },
      });
      if (attempt.ok && attempt.body) {
        const accessToken = String(attempt.body.access_token ?? "");
        const user = await whoIs(accessToken);
        if (user)
          return {
            session: toSession(
              user,
              accessToken,
              String(attempt.body.refresh_token ?? "") || null,
            ),
          };
        return { failure: "invalid_credentials" };
      }

      const failure = classify(attempt.status, attempt.body);
      if (failure !== "invalid_credentials") return { failure };
      if (!signupAllowed(config.env ?? process.env))
        return { failure: "invite_required" };
      if (
        typeof request.invite !== "string" ||
        request.invite.trim().length < 6
      )
        return { failure: "invite_required" };

      const created = await supabase("/signup", {
        method: "POST",
        body: { email: request.email, password: request.password },
      });
      if (!created.ok)
        return { failure: classify(created.status, created.body) };
      const accessToken = String(created.body?.access_token ?? "");
      if (!accessToken) return { failure: "provider_error" };
      const user = await whoIs(accessToken);
      if (!user) return { failure: "provider_error" };
      return {
        session: toSession(
          user,
          accessToken,
          String(created.body?.refresh_token ?? "") || null,
        ),
      };
    },

    /**
     * Ask the provider to send a link. The address is handed over and nothing
     * is said about whether it holds an account, which is the same sentence
     * either way.
     */
    async requestMagicLink(email) {
      if (!service.isConfigured()) return "provider_error";
      if (typeof email !== "string" || !email.includes("@"))
        return "invalid_credentials";
      const result = await supabase("/otp", {
        method: "POST",
        body: {
          email,
          // A login, never a registration. Registration is a separate decision
          // and it is the one that is switched off.
          create_user: false,
          options: { emailRedirectTo: `${config.siteOrigin}/login` },
        },
      });
      if (result.ok) return null;
      return result.status >= 500 ? "provider_error" : "invalid_credentials";
    },

    async signOut(session) {
      if (!session?.accessToken || !service.isConfigured()) return;
      try {
        await doFetch(
          `${String(config.supabaseUrl).replace(/\/+$/, "")}/auth/v1/logout`,
          {
            method: "POST",
            headers: {
              apikey: config.supabaseKey,
              Authorization: `Bearer ${session.accessToken}`,
              "content-type": "application/json",
            },
            body: session.refreshToken
              ? JSON.stringify({ refresh_token: session.refreshToken })
              : undefined,
          },
        );
      } catch {
        /* The cookie is cleared either way and a failed revoke expires alone. */
      }
    },
  };
  return service;
}

const envValue = (name, env) => {
  const raw = env[name];
  return raw && raw.trim() !== "" ? raw.trim() : undefined;
};

/**
 * Read the broker out of the environment, once per process. Nothing here throws
 * when a variable is missing: a deployment without them is a deployment whose
 * account routes say the feature is not configured here, which is the same
 * degradation the store already uses when `DATABASE_URL` is absent.
 */
export function accountServiceFromEnv(env = process.env) {
  return createAccountService({
    supabaseUrl: envValue("SUPABASE_URL", env) ?? "",
    supabaseKey: envValue("SUPABASE_ANON_KEY", env) ?? "",
    sessionSecret: envValue("VOID_ACCOUNT_SEAL_KEY", env),
    siteOrigin: envValue("VOID_PUBLIC_ORIGIN", env) ?? "https://chat.voidagent.tech",
    env,
  });
}

/**
 * A key this deployment can read and nothing else can, derived from the cloud
 * secret rather than configured separately. It is used for exactly one thing:
 * the OAuth `state` value, which has to carry an owner through a redirect to a
 * third party that must not be able to read it. A distinct `purpose` per use
 * means a key derived here can never open anything sealed for another purpose.
 */
export function derivedKey(purpose) {
  const material = Buffer.from(process.env.VOID_SECRET_KEY ?? "", "base64");
  if (material.length !== 32)
    throw new Error("Cloud encryption key is not configured.");
  return Buffer.from(
    hkdfSync(
      "sha256",
      material,
      Buffer.from("void-cloud"),
      Buffer.from(String(purpose)),
      32,
    ),
  );
}

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
 * Five properties are load bearing and each one has a test in
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
 * **Nothing here decodes a token.** The access token is opaque: it is handed to
 * the provider as a bearer and the answer is an id, never a set of claims. A
 * JWT payload is signed by the provider, not by this code, so a claim read out
 * of one is evidence of nothing, and a request the provider will not confirm
 * yields no identity at all rather than the identity somebody else chose. This
 * is also why there is no role in the session: a role read from a claim is the
 * obvious wrong turn the first time somebody needs one, and the right answer is
 * the provider round trip `whoIs()` already makes.
 *
 * **The API never says whether an address holds an account.** A wrong password,
 * an unknown address and a provider answer that names the address all collapse
 * into one failure and one sentence, and the collapsing happens in `classify`
 * here, not by the provider's good behaviour. Supabase is under no obligation
 * to answer an unknown address the way it answers a wrong password, so a
 * defence that leaned on it answering both alike would not be a defence.
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
/**
 * A session ends at `expiresAt`, thirty days from the sign in, and nothing
 * moves that date. It is the floor under the cookie, not a promise about how
 * long a person is welcome: the session also ends the moment the provider
 * stops honouring the refresh token the cookie carries, which is what signing
 * out anywhere does.
 *
 * What decides every request in between is the provider's access token, whose
 * life is minutes to an hour and is not ours to choose. A sealed cookie is a
 * bearer of that token, so the honest reading of a live cookie is "this
 * person has a credential the provider still accepts", and the only thing
 * that keeps that true past the token's own end is a refresh.
 */
/**
 * How long before the provider's stated expiry a token counts as spent. One
 * minute is enough to cover a request that has already started, and it is not
 * a security setting: a token the provider will not accept is refused whether
 * this number says it is fresh or not.
 */
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;
/**
 * Used only when the provider's answer carries no `expires_in`. Supabase's
 * default access token life is one hour. It decides when to refresh early; it
 * never decides whether a token works, because that question is only ever put
 * to the provider.
 */
const DEFAULT_ACCESS_TTL_MS = 60 * 60 * 1000;

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

/**
 * `expiresAt` is passed whenever the session has one, and the header then
 * says exactly what the sealed session inside it says. A cookie re-issued
 * after a refresh would otherwise advertise a fresh thirty days while the
 * session has fewer left, and the browser would go on presenting a cookie the
 * server has already decided to refuse.
 */
export function setSessionCookie(res, sealed, expiresAt) {
  const maxAge =
    typeof expiresAt === "number"
      ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      : Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    "set-cookie",
    `${COOKIE}=${sealed}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
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
 * The codes and the sentences a provider reaches for when the answer is about
 * the address rather than about the attempt. `user_already_exists` is the
 * dangerous one, because it confirms the address is registered, and
 * `user_not_found` says the opposite, so a provider careless enough to answer
 * the two cases differently has already handed the caller a way to tell them
 * apart.
 */
const ADDRESS_CODES = new Set([
  "user_already_exists",
  "user_not_found",
  "email_exists",
  "email_not_confirmed",
]);
const ADDRESS_PHRASES = [
  "already registered",
  "not registered",
  "no user found",
  "user not found",
];

const namesTheAddress = (body) => {
  const code = typeof body?.error_code === "string" ? body.error_code : "";
  if (ADDRESS_CODES.has(code)) return true;
  const message = typeof body?.msg === "string" ? body.msg.toLowerCase() : "";
  return ADDRESS_PHRASES.some((phrase) => message.includes(phrase));
};

/**
 * Supabase answers 200 for a session and 400 for nearly everything else, with a
 * machine code in the body, and nothing in that body is passed on to the caller.
 *
 * An answer that names the address is the same sentence as a wrong password
 * whatever status arrived with it, which is the whole point: the rule is ours
 * and holds for a provider that is careless with its status codes, not only for
 * one that answers every refusal identically. What is left once the naming
 * answers are taken out is a rate limit or an outage, and only those become
 * `provider_error`. Anything this module cannot interpret is answered
 * conservatively.
 */
const classify = (status, body) => {
  if (namesTheAddress(body)) return "invalid_credentials";
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

  /**
   * When the credential in a session runs out, as the provider stated it. The
   * provider's own `expires_in` is the only honest source; the default is what
   * to believe when it says nothing, and it is a guess about when to refresh
   * early rather than a claim that a token works.
   */
  const accessTokenExpiry = (expiresIn) => {
    const life = Number(expiresIn);
    return (
      now() + (Number.isFinite(life) && life > 0 ? life * 1000 : DEFAULT_ACCESS_TTL_MS)
    );
  };

  const toSession = (user, accessToken, refreshToken, expiresIn) => ({
    userId: user.id,
    email: String(user.email ?? "").toLowerCase(),
    accessToken,
    refreshToken: refreshToken || null,
    accessTokenExpiresAt: accessTokenExpiry(expiresIn),
    // Counted once, at the sign in, and never moved again. See `refresh`.
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
     * Whether the credential in this session is at its end, judged by the
     * expiry the provider gave when it issued it. A session sealed before this
     * field existed carries no answer, and counts as spent: refreshing a token
     * that turns out to be good costs one request, and the alternative is
     * trusting a guess about how long somebody's session lasts.
     */
    atTokenEnd(session) {
      return (
        typeof session?.accessTokenExpiresAt !== "number" ||
        session.accessTokenExpiresAt - now() <= ACCESS_TOKEN_SKEW_MS
      );
    },

    /**
     * Trade the refresh token the cookie carries for a new access token.
     *
     * This is the only thing that can carry a session past the provider's
     * access token, so it is also the only thing that can turn a copied cookie
     * back into a working one, and what ends it is the provider revoking that
     * refresh token. It cannot mint anything: the answer has to be an access
     * token the provider will vouch for, and the person that token belongs to
     * has to be the person this cookie was sealed for. A refresh that answers
     * with somebody else's id is a refusal, not a change of owner.
     */
    async refresh(session) {
      if (!service.isConfigured()) return null;
      if (typeof session?.refreshToken !== "string" || !session.refreshToken)
        return null;
      let result;
      try {
        result = await supabase("/token?grant_type=refresh_token", {
          method: "POST",
          body: { refresh_token: session.refreshToken },
        });
      } catch {
        return null;
      }
      const accessToken = result.ok
        ? String(result.body?.access_token ?? "")
        : "";
      if (!accessToken) return null;
      let user = null;
      try {
        user = await whoIs(accessToken);
      } catch {
        return null;
      }
      if (user?.id !== session.userId) return null;
      return {
        ...session,
        accessToken,
        // A provider may rotate the refresh token, and one that does not send
        // a replacement has not withdrawn the one in hand. Dropping it would
        // end a session that is still perfectly good.
        refreshToken:
          String(result.body?.refresh_token ?? "") || session.refreshToken,
        accessTokenExpiresAt: accessTokenExpiry(result.body?.expires_in),
        // The one date a refresh does not move. Thirty days is thirty days from
        // the sign in; a refresh token is not a way to buy thirty more.
        expiresAt: session.expiresAt,
      };
    },

    /**
     * The session a request may use, renewed if the credential in it is at its
     * end, and null when there is none to use.
     *
     * Both refusals are the same refusal and both end the session: a provider
     * that will not vouch for the token, and a provider that will not trade the
     * refresh token for a new one. Nothing here falls back to a stale token, to
     * a local decision about who the holder is, or to a session with the
     * credential removed, because each of those is a way to be signed in
     * without a credential.
     */
    async liveSession(session) {
      if (!session) return null;
      let current = session;
      if (service.atTokenEnd(session)) {
        const renewed = await service.refresh(session);
        // A refresh the provider refused is the end of the session. Falling
        // back to the token that was just refused would be signing the person
        // in on the very credential that no longer works.
        if (!renewed) return null;
        current = renewed;
      }
      let user = null;
      try {
        user = await whoIs(current.accessToken);
      } catch {
        return null;
      }
      // The token ended sooner than the number the provider gave said it would.
      // That happens, and the answer is one refresh and then a decision, not a
      // loop and not a guess.
      if (!user && current === session) {
        const renewed = await service.refresh(session);
        if (!renewed) return null;
        current = renewed;
        try {
          user = await whoIs(current.accessToken);
        } catch {
          return null;
        }
      }
      if (user?.id !== session.userId) return null;
      return { session: current, user, refreshed: current !== session };
    },

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
            request.expires_in,
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
              attempt.body.expires_in,
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
          created.body?.expires_in,
        ),
      };
    },

    /**
     * Ask the provider to send a link. The address is handed over and nothing
     * is said about whether it holds an account, which is the same sentence
     * either way. The answer goes through the same `classify` as a password
     * sign in, so a provider that names the address on this path is collapsed
     * here too rather than only on the other one.
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
      return classify(result.status, result.body);
    },

    /**
     * Revoke at the provider, which is the only act that ends a session
     * anywhere else. That takes a bearer the provider still accepts, so a
     * session sitting past its access token's end is renewed first: sending an
     * expired token to `/logout` is refused, and a refused revoke leaves the
     * refresh token alive for the other device holding the same cookie. A
     * session that cannot be renewed has nothing left to revoke, which is the
     * same end by a different road.
     */
    async signOut(session) {
      if (!session?.accessToken || !service.isConfigured()) return;
      const live = service.atTokenEnd(session)
        ? await service.refresh(session)
        : session;
      if (!live?.accessToken) return;
      try {
        await doFetch(
          `${String(config.supabaseUrl).replace(/\/+$/, "")}/auth/v1/logout`,
          {
            method: "POST",
            headers: {
              apikey: config.supabaseKey,
              Authorization: `Bearer ${live.accessToken}`,
              "content-type": "application/json",
            },
            body: live.refreshToken
              ? JSON.stringify({ refresh_token: live.refreshToken })
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

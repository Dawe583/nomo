import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { openSession, SESSION_COOKIE, sealSession } from "./account.mjs";

/**
 * The account routes over real HTTP, against a real Express app and a real
 * identity provider running on loopback.
 *
 * The provider here is a genuine HTTP server rather than a stubbed `fetch`, so
 * every case exercises the whole path: a body arrives, the broker calls the
 * provider over a socket, the answer is classified, and a sealed cookie comes
 * back. No mocking library is involved and no case passes without a working
 * request.
 *
 * The provider answers the way Supabase does, and the difference between its
 * two refusals is the point of the suite. A wrong password for an address that
 * exists and an address that does not exist are two different provider answers
 * carrying two different machine codes, one of which confirms the address is
 * registered. Everything a caller can observe about either case has to be the
 * same, and the only thing that makes it the same is this repository's code.
 */
const KNOWN = {
  email: "person@example.com",
  password: "correct horse battery staple",
  id: "11111111-2222-3333-4444-555555555555",
};
/**
 * The provider's own access token life, and the only number in this suite that
 * decides how long a session lasts. It is short so the tests do not have to
 * wait for it: the tests move the provider's clock instead, which is the same
 * thing happening at a different speed.
 */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const REFRESH_TOKEN = "provider-refresh-token";
let minted = 0;
/** The provider's clock, which a test may move. */
let clock = Date.now();
/** Access tokens the provider has issued, each with the moment it stops working. */
const live = new Map();
/** Refresh tokens the provider still honours. Signing out removes from this. */
const honoured = new Set([REFRESH_TOKEN]);
const grants = [];
const asked = [];
// `answering` is the provider being itself. `outage` is a 500. `naming-500` is
// the worst case: a provider careless enough to name the address while also
// reporting a server error, which a status-led rule would report as an outage.
let mode = "answering";

const issue = () => {
  const token = `provider-access-token-${++minted}`;
  live.set(token, { expiresAt: clock + TOKEN_LIFETIME_MS });
  return token;
};

const provider = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  asked.push(`${req.method} ${url.pathname}`);
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 204 ? undefined : JSON.stringify(body));
  };
  const read = (done) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => done(JSON.parse(body || "{}")));
  };
  if (mode === "outage") return send(500, { msg: "upstream unavailable" });
  if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
    return read((given) => {
      if (given.email === KNOWN.email && given.password === KNOWN.password) {
        // A sign in is a new provider session, so the refresh token in the
        // cookie it produces is one the provider will trade.
        honoured.add(REFRESH_TOKEN);
        return send(200, {
          access_token: issue(),
          refresh_token: REFRESH_TOKEN,
          expires_in: TOKEN_LIFETIME_MS / 1000,
        });
      }
      if (given.email === KNOWN.email)
        return send(400, {
          error_code: "invalid_credentials",
          msg: "Invalid login credentials",
        });
      if (mode === "naming-500")
        return send(500, {
          error_code: "user_not_found",
          msg: "No user found with this email",
        });
      return send(400, {
        error_code: "user_not_found",
        msg: "No user found with this email",
      });
    });
  }
  // The grant that decides whether a session outlives its access token, and
  // the only one that can bring a revoked session back.
  if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
    grants.push("refresh");
    return read(({ refresh_token: given }) => {
      if (!honoured.has(given))
        return send(400, {
          error_code: "refresh_token_not_found",
          msg: "Invalid Refresh Token",
        });
      return send(200, {
        access_token: issue(),
        expires_in: TOKEN_LIFETIME_MS / 1000,
      });
    });
  }
  if (url.pathname === "/auth/v1/user") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if ((live.get(token)?.expiresAt ?? 0) > clock)
      return send(200, { id: KNOWN.id, email: KNOWN.email });
    return send(401, { msg: "invalid claim: missing sub claim" });
  }
  // A logout is an authenticated act at the provider, so a bearer it will not
  // accept is refused and the refresh token survives. That refusal is why
  // signing out has to renew a spent credential first.
  if (url.pathname === "/auth/v1/logout") {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if ((live.get(token)?.expiresAt ?? 0) <= clock)
      return send(401, { msg: "invalid claim: missing sub claim" });
    return read(({ refresh_token: given }) => {
      if (given) honoured.delete(given);
      return send(204, {});
    });
  }
  return send(404, { msg: "not found" });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));

process.env.SUPABASE_URL = `http://127.0.0.1:${provider.address().port}`;
process.env.SUPABASE_ANON_KEY = "provider-anon-key";
process.env.NOMO_ACCOUNT_SEAL_KEY = randomBytes(32).toString("hex");
// A control token is configured, so the deployment is not in the 503 setup state
// and the account routes are what is under test rather than that refusal.
process.env.NOMO_CONTROL_TOKEN = "account-routes-test-token-".repeat(2);
const sealKey = process.env.NOMO_ACCOUNT_SEAL_KEY;

const { default: app } = await import("./server.mjs");
const server = createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;

after(
  () =>
    new Promise((resolve) => {
      server.close(resolve);
      provider.close(resolve);
    }),
);

const post = (path, body, headers = {}) =>
  fetch(url + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const signIn = (email, password, headers = {}) =>
  post("/api/account/signin", { email, password }, headers);
const cookieOf = (response) => response.headers.get("set-cookie").split(";")[0];

test("a deployment with a provider says so, and says nothing about an address", async () => {
  // Broken by: answering the probe with a failure, which sends every visitor to
  // the workspace token gate on a server that has accounts.
  const probe = await fetch(url + "/api/account");
  assert.equal(probe.status, 200);
  assert.deepEqual(await probe.json(), { configured: true, signedIn: false });
  // The probe is the only way to that answer and it must not need a cookie.
  assert.equal(probe.headers.get("set-cookie"), null);
});

test("a wrong password and an address that holds no account are one refusal", async () => {
  // Broken by: forwarding the provider's answer, or its status, or its message.
  // The provider answered these two cases differently on purpose: one with
  // `invalid_credentials` and one with `user_not_found`, which confirms the
  // address is not registered. A caller able to tell them apart has an account
  // enumeration oracle, and the only thing standing between them and one is
  // this repository's classify step.
  const wrongPassword = await signIn(KNOWN.email, "not the password");
  const unknownAddress = await signIn("nobody@example.com", "whatever");
  const first = await wrongPassword.json();
  const second = await unknownAddress.json();
  assert.equal(wrongPassword.status, unknownAddress.status);
  assert.equal(wrongPassword.status, 403);
  assert.deepEqual(first, second);
  const said = JSON.stringify(first);
  for (const provider of [
    "no user found",
    "user_not_found",
    "invalid login credentials",
    "invalid_credentials",
  ])
    assert.equal(said.toLowerCase().includes(provider), false, said);
  // Signup is off, so an unconfirmed attempt cannot be a fresh registration and
  // the refusal says so without claiming anything about the address.
  assert.equal(first.error, "invite_required");
  assert.match(first.message, /does not create new accounts/i);
  // And it never claims the person is not invited, which would be a guess about
  // an address this code cannot see.
  assert.equal(/invitation/i.test(said), false, said);
  // A refused attempt leaves no session behind.
  assert.equal(wrongPassword.headers.get("set-cookie"), null);
  assert.equal(unknownAddress.headers.get("set-cookie"), null);
});

test("a provider that names the address while reporting a server error is still a refusal", async () => {
  // Broken by: classifying on the status alone, which reports this as an outage
  // and tells a person their password is wrong exactly when it was not. The
  // address is named, so the naming answer wins over the 500.
  mode = "naming-500";
  try {
    const answer = await signIn("nobody@example.com", "whatever");
    assert.equal(answer.status, 403);
    const said = JSON.stringify(await answer.json());
    assert.equal(/no user found|user_not_found/i.test(said), false, said);
  } finally {
    mode = "answering";
  }
});

test("a sign in is answered with a sealed HttpOnly cookie and no token in sight", async () => {
  // Broken by: returning the provider's access token to the browser, or setting
  // the cookie without HttpOnly, either of which hands the credential to a
  // script on the page.
  const before = minted;
  const answer = await signIn(KNOWN.email, KNOWN.password);
  assert.equal(answer.status, 200);
  // Whichever token this sign in was issued, it is the credential that has to
  // stay off the wire and inside the seal.
  const issued = `provider-access-token-${before + 1}`;
  const cookie = answer.headers.get("set-cookie");
  assert.match(cookie, /^__Host-void-account=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(cookie.includes(issued), false, "the cookie is not sealed");
  const body = await answer.json();
  assert.deepEqual(body, { signedIn: true, email: KNOWN.email });
  assert.equal(
    JSON.stringify(body).includes(issued),
    false,
    "the provider token reached the browser",
  );
  // The cookie really does open, and it opens to the token the provider issued
  // together with the moment that token stops working.
  const opened = openSession(cookieOf(answer).split("=")[1], sealKey);
  assert.equal(opened.userId, KNOWN.id);
  assert.equal(opened.accessToken, issued);
  assert.equal(opened.refreshToken, REFRESH_TOKEN);
  assert.ok(
    opened.accessTokenExpiresAt > Date.now(),
    "the session records when its credential runs out",
  );
});

test("the cookie that comes back is the session the next request uses", async () => {
  // Broken by: sealing something the middleware cannot read back, which is the
  // shape that makes a sign in screen look like it worked and then refuse every
  // request the person makes.
  const answer = await signIn(KNOWN.email, KNOWN.password);
  const cookie = cookieOf(answer);
  const probe = await fetch(url + "/api/account", { headers: { cookie } });
  assert.deepEqual(await probe.json(), {
    configured: true,
    signedIn: true,
    email: KNOWN.email,
  });
  // And it is an owner, not merely a recognised visitor.
  const capabilities = await fetch(url + "/api/capabilities", {
    headers: { cookie },
  });
  assert.equal(capabilities.status, 200);
});

test("an edited cookie is not a session", async () => {
  // Broken by: accepting a cookie that did not fail to open, which is how a
  // visitor becomes an owner by editing a string in their own browser.
  const answer = await signIn(KNOWN.email, KNOWN.password);
  const [name, value] = cookieOf(answer).split("=");
  const tampered = value.slice(0, -4) + (value.endsWith("AAAA") ? "BBBB" : "AAAA");
  const probe = await fetch(url + "/api/account", {
    headers: { cookie: `${name}=${tampered}` },
  });
  assert.equal((await probe.json()).signedIn, false);
  const refused = await fetch(url + "/api/capabilities", {
    headers: { cookie: `${name}=${tampered}` },
  });
  assert.equal(refused.status, 401);
});

test("a provider outage is a 502 and not a refused password", async () => {
  // Broken by: collapsing a 500 into a refusal, which tells a person their
  // password is wrong when the provider is simply down.
  mode = "outage";
  try {
    const answer = await signIn(KNOWN.email, KNOWN.password);
    assert.equal(answer.status, 502);
    assert.equal(
      (await answer.json()).message.includes("upstream unavailable"),
      false,
    );
  } finally {
    mode = "answering";
  }
});

test("a cross-site sign in is refused even though the route needs no credential", async () => {
  // Broken by: moving the account routes above the origin checks, which would
  // leave a login form any page on the internet can post to.
  assert.equal((await signIn(KNOWN.email, KNOWN.password)).status, 200);
  const cross = await signIn(KNOWN.email, KNOWN.password, {
    origin: "https://evil.example",
  });
  assert.equal(cross.status, 403);
  assert.equal(cross.headers.get("set-cookie"), null);
  const fetched = await signIn(KNOWN.email, KNOWN.password, {
    "sec-fetch-site": "cross-site",
  });
  assert.equal(fetched.status, 403);
  // A cross-site probe learns nothing either.
  const probe = await fetch(url + "/api/account", {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(probe.status, 403);
});

test("signing out clears the cookie and revokes the provider session", async () => {
  // Broken by: clearing the cookie without revoking, which leaves a usable
  // provider token alive after the person said they were leaving.
  const answer = await signIn(KNOWN.email, KNOWN.password);
  const cookie = cookieOf(answer);
  const out = await fetch(url + "/api/account", {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0$/);
  assert.equal(asked.includes("POST /auth/v1/logout"), true);
  assert.deepEqual(await out.json(), { signedIn: false });
  // Signing out with no cookie at all is not an error either.
  assert.equal((await fetch(url + "/api/account", { method: "DELETE" })).status, 200);
});

test("this route signs a person in and never creates an account", async () => {
  // Broken by: accepting a `method`, an `invite` or an otp flag from the body,
  // which is how a magic link, an invited signup or a registration would reach
  // a screen the broker cannot complete.
  assert.equal(process.env.NOMO_ACCOUNT_SIGNUP, undefined);
  const invited = await post("/api/account/signin", {
    email: "newcomer@example.com",
    password: "a password",
    invite: "abcdef",
  });
  assert.equal(invited.status, 403);
  // The method is not read from the body. Asking for a link therefore arrives
  // as a password sign in with no password, which is refused on the shape of
  // the request alone, and nothing reaches the provider at all.
  const before = asked.length;
  const link = await post("/api/account/signin", {
    method: "magic_link",
    email: KNOWN.email,
  });
  assert.equal(link.status, 401);
  assert.equal(asked.length, before, "the provider was consulted anyway");
  // A signup would have to reach the provider to create anything, and it never
  // did. Nor did a one time password request.
  assert.deepEqual(asked.filter((entry) => entry.includes("signup")), []);
  assert.deepEqual(asked.filter((entry) => entry.includes("otp")), []);
});

/**
 * What a session actually is, measured against the provider rather than
 * against the cookie.
 *
 * The cookie says thirty days. The credential in it does not last that long:
 * the provider's access token has its own short expiry, and the middleware
 * asks the provider who a token belongs to on every single request. So the
 * lifetime of a session is the provider's token life plus whatever the refresh
 * token in the cookie can still buy, and not one second of it is ours to
 * decide. The tests below move the provider's clock rather than waiting.
 */
test("a session outlives the access token, by trading the refresh token in the cookie", async () => {
  // Broken by: dropping the refresh, which signs a person out roughly an hour
  // after signing in while the cookie still says thirty days, or by keeping
  // the refresh and letting the renewed credential stay on the server, which
  // leaves the browser holding a cookie that no longer opens anything.
  const was = clock;
  try {
    const answer = await signIn(KNOWN.email, KNOWN.password);
    const cookie = cookieOf(answer);
    const before = openSession(cookie.split("=")[1], sealKey);
    const asked0 = grants.length;
    assert.equal(
      (await fetch(url + "/api/capabilities", { headers: { cookie } })).status,
      200,
    );
    // A credential the provider still vouches for is not worth a refresh.
    assert.equal(grants.length, asked0);

    // The provider's clock passes the access token's end. Nothing here moved
    // that token and nothing can make it work again: it is simply no longer
    // one the provider will answer for.
    clock += TOKEN_LIFETIME_MS + 1;
    const capabilities = await fetch(url + "/api/capabilities", {
      headers: { cookie },
    });
    assert.equal(capabilities.status, 200, "the session outlived its access token");
    assert.equal(grants.length, asked0 + 1, "and it did so by refreshing, once");

    // The renewal comes back as the same sealed HttpOnly cookie, and the
    // browser still never holds a provider token.
    const renewed = capabilities.headers.get("set-cookie");
    assert.match(renewed, /^__Host-void-account=/);
    assert.match(renewed, /HttpOnly/);
    assert.equal(renewed.includes(before.accessToken), false, "the cookie is not sealed");
    const after = openSession(renewed.split(";")[0].split("=")[1], sealKey);
    assert.notEqual(after.accessToken, before.accessToken, "a new credential, not the old one");
    assert.equal(after.refreshToken, REFRESH_TOKEN, "and the one in hand still works");

    // The person gets the renewed cookie, so a browser that presents it is in.
    assert.equal(
      (await fetch(url + "/api/capabilities", {
        headers: { cookie: renewed.split(";")[0] },
      })).status,
      200,
    );
  } finally {
    clock = was;
  }
});

test("a session with a spent credential is renewed before the provider is asked about it", async () => {
  // Broken by: refreshing only after a failure, which turns every request in
  // the last minute of a token's life into two round trips to the provider
  // and a person waiting on the slower one. The expiry the provider stated is
  // in the sealed session for exactly this.
  const was = clock;
  try {
    const answer = await signIn(KNOWN.email, KNOWN.password);
    const opened = openSession(cookieOf(answer).split("=")[1], sealKey);
    const spent = sealSession(
      { ...opened, accessTokenExpiresAt: Date.now() - 1 },
      sealKey,
    );
    const asked0 = grants.length;
    const capabilities = await fetch(url + "/api/capabilities", {
      headers: { cookie: `${SESSION_COOKIE}=${spent}` },
    });
    assert.equal(capabilities.status, 200);
    assert.equal(
      grants.length,
      asked0 + 1,
      "the refresh happened on the way in, not after a refusal",
    );
  } finally {
    clock = was;
  }
});

test("a session whose refresh has been revoked ends, and falls back to nothing", async () => {
  // Broken by: answering with the sealed identity once the provider stops
  // honouring the refresh token, or with the access token that has just been
  // refused, or by leaving the cookie in place. Each is signing a person in
  // without a credential, and the first is what a stolen cookie looks like.
  const was = clock;
  try {
    // Two devices and one person: the same provider session, so the same
    // refresh token inside two sealed cookies. This is the case a review named,
    // and the answer belongs to the provider rather than to either cookie.
    const here = cookieOf(await signIn(KNOWN.email, KNOWN.password));
    const there = cookieOf(await signIn(KNOWN.email, KNOWN.password));
    assert.equal(
      (await fetch(url + "/api/capabilities", { headers: { cookie: there } })).status,
      200,
    );
    const stale = openSession(there.split("=")[1], sealKey);

    // Signing out takes a bearer the provider still accepts. Here the
    // deployment knows its credential is spent and the provider agrees, which
    // is the ordinary case rather than an edge. Send the spent one and the
    // logout is refused and the refresh token survives, which is the reviewer's
    // worry made real instead of feared.
    clock += TOKEN_LIFETIME_MS + 1;
    const spent = sealSession(
      {
        ...openSession(here.split("=")[1], sealKey),
        accessTokenExpiresAt: Date.now() - 1,
      },
      sealKey,
    );
    const out = await fetch(url + "/api/account", {
      method: "DELETE",
      headers: { cookie: `${SESSION_COOKIE}=${spent}` },
    });
    assert.equal(out.status, 200);
    assert.equal(honoured.has(REFRESH_TOKEN), false, "signing out revoked the session");

    // The other device's cookie is untouched, sealed, HttpOnly, and well
    // inside the thirty days it claims. What ended it is the provider.
    assert.ok(stale.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000);
    assert.equal(openSession(there.split("=")[1], sealKey).userId, KNOWN.id);

    const before = grants.length;
    const probe = await fetch(url + "/api/account", { headers: { cookie: there } });
    assert.equal((await probe.json()).signedIn, false);
    assert.match(
      probe.headers.get("set-cookie"),
      /Max-Age=0$/,
      "a session that is over has its cookie cleared, not left half alive",
    );
    const refused = await fetch(url + "/api/capabilities", {
      headers: { cookie: there },
    });
    assert.equal(refused.status, 401);
    // One attempt per request and no second try: it ended by being refused a
    // refresh, not by being talked round.
    assert.equal(grants.length, before + 2);

    // The other order of the same session: the deployment already knows the
    // credential is spent when the request arrives, so it goes to refresh
    // first. A refusal there is the same end, and the sealed identity is not
    // an answer to it.
    const alreadySpent = sealSession(
      { ...stale, accessTokenExpiresAt: Date.now() - 1 },
      sealKey,
    );
    const asked0 = grants.length;
    assert.equal(
      (await fetch(url + "/api/capabilities", {
        headers: { cookie: `${SESSION_COOKIE}=${alreadySpent}` },
      })).status,
      401,
    );
    assert.equal(grants.length, asked0 + 1, "one refresh attempt, and no fallback to anything");
  } finally {
    clock = was;
  }
});

test("the cookie's own window is the window the code honours", async () => {
  // Broken by: a fixed `Max-Age`, which makes a cookie advertise thirty days
  // for a session with two minutes left and a person keep being told they are
  // signed in to something the server has already refused. And broken by a
  // refresh that moves `expiresAt`, which makes the window never end.
  const was = clock;
  try {
    const answer = await signIn(KNOWN.email, KNOWN.password);
    const opened = openSession(cookieOf(answer).split("=")[1], sealKey);
    const thirty = 30 * 24 * 60 * 60 * 1000;
    assert.ok(
      opened.expiresAt - Date.now() <= thirty,
      "the session ends thirty days after the sign in",
    );

    // A refresh renews the credential and nothing else.
    clock += TOKEN_LIFETIME_MS + 1;
    const renewed = await fetch(url + "/api/capabilities", {
      headers: { cookie: cookieOf(answer) },
    });
    assert.equal(renewed.status, 200);
    const after = openSession(
      renewed.headers.get("set-cookie").split(";")[0].split("=")[1],
      sealKey,
    );
    assert.notEqual(after.accessToken, opened.accessToken);
    assert.equal(after.expiresAt, opened.expiresAt, "a refresh must not move the session's end");

    // The header says what the seal says. A session with two minutes left comes
    // back in a cookie saying two minutes, and a fixed Max-Age fails here.
    const brief = sealSession(
      { ...after, expiresAt: Date.now() + 120_000 },
      sealKey,
    );
    const probe = await fetch(url + "/api/account", {
      headers: { cookie: `${SESSION_COOKIE}=${brief}` },
    });
    const claimed = probe.headers.get("set-cookie");
    assert.match(claimed, /^__Host-void-account=/);
    assert.ok(
      +/Max-Age=(\d+)/.exec(claimed)[1] <= 120,
      `a two minute session was issued a cookie claiming ${claimed}`,
    );

    // And the window is a window: past it the session is refused here, before
    // the provider is asked anything, whatever the refresh token still says.
    const over = sealSession({ ...after, expiresAt: Date.now() - 1 }, sealKey);
    const before = grants.length;
    assert.equal(
      (await fetch(url + "/api/capabilities", {
        headers: { cookie: `${SESSION_COOKIE}=${over}` },
      })).status,
      401,
    );
    assert.equal(
      grants.length,
      before,
      "a session past its own end is not refreshed into another one",
    );
  } finally {
    clock = was;
  }
});

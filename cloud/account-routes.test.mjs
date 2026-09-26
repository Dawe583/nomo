import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { openSession } from "./account.mjs";

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
const ACCESS_TOKEN = "provider-access-token-do-not-leak";
const asked = [];
// `answering` is the provider being itself. `outage` is a 500. `naming-500` is
// the worst case: a provider careless enough to name the address while also
// reporting a server error, which a status-led rule would report as an outage.
let mode = "answering";

const provider = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  asked.push(`${req.method} ${url.pathname}`);
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 204 ? undefined : JSON.stringify(body));
  };
  if (mode === "outage") return send(500, { msg: "upstream unavailable" });
  if (url.pathname === "/auth/v1/token") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    return req.on("end", () => {
      const given = JSON.parse(body || "{}");
      if (given.email === KNOWN.email && given.password === KNOWN.password)
        return send(200, {
          access_token: ACCESS_TOKEN,
          refresh_token: "provider-refresh-token",
        });
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
  if (url.pathname === "/auth/v1/user") {
    if (req.headers.authorization === `Bearer ${ACCESS_TOKEN}`)
      return send(200, { id: KNOWN.id, email: KNOWN.email });
    return send(401, { msg: "invalid claim: missing sub claim" });
  }
  if (url.pathname === "/auth/v1/logout") return send(204, {});
  return send(404, { msg: "not found" });
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));

process.env.SUPABASE_URL = `http://127.0.0.1:${provider.address().port}`;
process.env.SUPABASE_ANON_KEY = "provider-anon-key";
process.env.VOID_ACCOUNT_SEAL_KEY = randomBytes(32).toString("hex");
// A control token is configured, so the deployment is not in the 503 setup state
// and the account routes are what is under test rather than that refusal.
process.env.VOID_CONTROL_TOKEN = "account-routes-test-token-".repeat(2);
const sealKey = process.env.VOID_ACCOUNT_SEAL_KEY;

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
  const answer = await signIn(KNOWN.email, KNOWN.password);
  assert.equal(answer.status, 200);
  const cookie = answer.headers.get("set-cookie");
  assert.match(cookie, /^__Host-void-account=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(cookie.includes(ACCESS_TOKEN), false, "the cookie is not sealed");
  const body = await answer.json();
  assert.deepEqual(body, { signedIn: true, email: KNOWN.email });
  assert.equal(
    JSON.stringify(body).includes(ACCESS_TOKEN),
    false,
    "the provider token reached the browser",
  );
  // The cookie really does open, and it opens to the token the provider issued.
  const opened = openSession(cookieOf(answer).split("=")[1], sealKey);
  assert.equal(opened.userId, KNOWN.id);
  assert.equal(opened.accessToken, ACCESS_TOKEN);
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
  assert.equal(process.env.VOID_ACCOUNT_SIGNUP, undefined);
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

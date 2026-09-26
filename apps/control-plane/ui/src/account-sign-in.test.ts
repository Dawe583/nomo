import test from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_ANSWER_ID,
  ACCOUNT_PROBE_PATH,
  ACCOUNT_SIGN_IN_PATH,
  accountCopy,
  accountScreen,
  classifyFailure,
  failureMessage,
  fieldErrors,
  firstBrokenField,
  focusTarget,
  gateScreen,
  noFieldErrors,
  signInBody,
} from "./account-sign-in.ts";

// The English half only. A Czech copy that drifted would be a translation
// problem, and these cases are about which screen is shown and what it says
// about the credential, neither of which changes with the locale.
const t = (_cs: string, en: string) => en;

test("the account paths are same-origin and name no identity provider", () => {
  // Broken by: pointing either path at a provider origin, which is exactly what
  // `connect-src 'self'` in vercel.json forbids and what would put a provider
  // token in the browser instead of a sealed cookie in an HttpOnly header.
  for (const path of [ACCOUNT_PROBE_PATH, ACCOUNT_SIGN_IN_PATH]) {
    assert.match(path, /^\/api\//);
    assert.equal(path.includes("://"), false, `${path} is not a relative path`);
    assert.equal(/supabase|auth0|oauth|https?:/i.test(path), false, `${path} names a provider`);
  }
  assert.equal(ACCOUNT_PROBE_PATH, "/api/account");
  assert.equal(ACCOUNT_SIGN_IN_PATH, "/api/account/signin");
});

test("a deployment with accounts shows the sign in and one without keeps the token gate", () => {
  // Broken by: dropping the `configured` branch, which would ask every visitor
  // for a machine token on a deployment that has accounts.
  assert.equal(gateScreen({ pending: true, configured: true }), "loading");
  assert.equal(gateScreen({ configured: true }), "account");
  assert.equal(gateScreen({ configured: false }), "workspace");
  assert.equal(gateScreen({}), "workspace");
});

test("a deployment answering 503 for every path is reported as being set up, not as a workspace", () => {
  // Broken by: letting `configured` outrank the 503, which would draw a sign in
  // form on a server that has no provider to sign in against.
  assert.equal(gateScreen({ status: 503 }), "unavailable");
  assert.equal(gateScreen({ status: 503, configured: true }), "unavailable");
  assert.equal(gateScreen({ status: 503, pending: true }), "loading");
  // A probe that failed for any other reason must not claim the server is being
  // configured; the token gate is the honest fallback.
  assert.equal(gateScreen({ status: 500 }), "workspace");
  assert.equal(gateScreen({ status: undefined }), "workspace");
});

test("an unanswered probe is loading and never a form", () => {
  // Broken by: returning "signed-out" for an absent probe, which flashes the
  // password form on a deployment whose accounts are about to appear.
  assert.equal(accountScreen(undefined), "loading");
  assert.equal(accountScreen(undefined, true), "loading");
});

test("a person already signed in is never shown the form again", () => {
  // Broken by: letting `busy` outrank `signedIn`, which replaces a signed in
  // screen with a password form in the middle of an in-flight request.
  assert.equal(accountScreen({ configured: true, signedIn: true }), "signed-in");
  assert.equal(
    accountScreen({ configured: true, signedIn: true }, true),
    "signed-in",
  );
  assert.equal(accountScreen({ configured: true }), "signed-out");
  assert.equal(accountScreen({ configured: true }, true), "submitting");
  assert.equal(accountScreen({ configured: false }), "unconfigured");
  assert.equal(accountScreen({}), "unconfigured");
});

test("an address is checked for shape and the password only for emptiness", () => {
  // Broken by: dropping the shape test, which sends a typo to the provider and
  // turns a local mistake into a refusal the person cannot act on.
  const both = fieldErrors("", "", t);
  assert.equal(both.email, "Enter your email address.");
  assert.equal(both.password, "Enter your password.");

  for (const bad of ["person", "person@", "@example.com", "person@example", "a b@c.d"]) {
    assert.equal(
      fieldErrors(bad, "secret", t).email,
      "Enter an email address like name@example.com.",
      `${bad} was accepted as an address`,
    );
  }
  for (const good of ["person@example.com", "a.b+c@sub.example.co.uk"]) {
    assert.equal(fieldErrors(good, "secret", t).email, null, `${good} was refused`);
  }
  // Surrounding whitespace is the visitor's, not the address's.
  assert.equal(fieldErrors("  person@example.com  ", "secret", t).email, null);
  assert.equal(fieldErrors("   ", "secret", t).email, "Enter your email address.");
  // A password that is present is never judged here, however short.
  assert.equal(fieldErrors("person@example.com", "x", t).password, null);
});

test("nothing in this screen says whether an address holds an account", () => {
  // Broken by: adding a branch that distinguishes an unknown address from a
  // wrong password, which is the one thing the broker exists to prevent.
  const copy = accountCopy(t);
  const sentences = [
    ...Object.values(copy).filter((v) => typeof v === "string"),
    fieldErrors("x", "", t).password ?? "",
  ].join(" ");
  // These are the sentences a provider reaches for when the answer is about
  // the address rather than about the attempt. A screen that shows any of them
  // has turned a wrong password into an account enumeration oracle.
  for (const leak of [
    "no account for",
    "not registered",
    "no user found",
    "user not found",
    "already registered",
    "already exists",
    "does not exist",
    "unknown address",
    "no such address",
    "account not found",
  ]) {
    assert.equal(
      sentences.toLowerCase().includes(leak),
      false,
      `the screen says something that names the address: ${leak}`,
    );
  }
  // Saying this deployment has no accounts at all is a statement about the
  // server and is allowed; it reveals nothing about any one visitor. Pinned
  // here so the allowance cannot quietly widen into the case above.
  assert.match(copy.unconfigured, /no accounts configured/i);
  assert.equal(/this (address|email)/i.test(sentences), false);
});

test("focus goes to the first broken field in reading order, then to whatever answered", () => {
  // Broken by: taking the second broken field first, which sends a person
  // fixing the password while their address is still the wrong one.
  assert.equal(firstBrokenField(noFieldErrors), null);
  assert.equal(firstBrokenField({ email: "x", password: "y" }), "email");
  assert.equal(firstBrokenField({ email: null, password: "y" }), "password");
  assert.equal(
    focusTarget({ email: "x", password: "y" }, "signed-out", true),
    "account-email",
  );
  assert.equal(
    focusTarget({ email: null, password: "y" }, "signed-out", true),
    "account-password",
  );
  assert.equal(
    focusTarget(noFieldErrors, "signed-out", true),
    ACCOUNT_ANSWER_ID,
  );
  assert.equal(
    focusTarget(noFieldErrors, "signed-in", true),
    ACCOUNT_ANSWER_ID,
  );
});

test("focus does not move before there is a sentence to read or while one is in flight", () => {
  // Broken by: focusing the answer region on first paint, which pulls the caret
  // out from under a person who has not typed anything yet, or yanking it off a
  // password that is still being typed.
  assert.equal(focusTarget(noFieldErrors, "signed-out", false), null);
  assert.equal(focusTarget(noFieldErrors, "submitting", true), null);
  // A broken field still wins over a submission in flight: the form is not
  // submitted with a field that is wrong, so there is no in-flight request.
  assert.equal(
    focusTarget({ email: "x", password: null }, "submitting", false),
    "account-email",
  );
});

test("a sign in carries an email and a password and nothing else", () => {
  // Broken by: adding `method`, `invite` or an otp flag to this object, which is
  // how a magic link, a registration or an invited signup would be smuggled onto
  // a screen the broker cannot complete.
  assert.deepEqual(Object.keys(signInBody("person@example.com", "secret")).sort(), [
    "email",
    "password",
  ]);
  assert.deepEqual(signInBody("  person@example.com  ", " secret "), {
    email: "person@example.com",
    password: " secret ",
  });
  // The password is never trimmed: leading and trailing spaces are part of it.
  assert.equal(signInBody("a@b.co", "  ").password, "  ");
});

test("a refusal is named by its status and answered in this repository's words", () => {
  // Broken by: mapping a status to a different failure, which tells a person
  // their password was refused when the provider was merely unreachable.
  assert.equal(classifyFailure(401), "invalid_credentials");
  assert.equal(classifyFailure(403), "invite_required");
  assert.equal(classifyFailure(502), "provider_error");
  assert.equal(classifyFailure(503), "setup");
  // No status at all is a refused connection, a timeout or an unparsed body.
  for (const status of [undefined, 0, 404, 418, 500, 504]) {
    assert.equal(classifyFailure(status), "unreachable", `status ${status}`);
  }
  assert.equal(
    failureMessage(classifyFailure(401), t),
    "That email and password were not accepted.",
  );
  assert.equal(
    failureMessage(classifyFailure(502), t),
    "The sign in service could not be reached. Try again shortly.",
  );
  // Every failure has a sentence, and none of them is empty or the same.
  const sentences = (
    [
      "invalid_credentials",
      "invite_required",
      "provider_error",
      "unreachable",
      "setup",
    ] as const
  ).map((f) => failureMessage(f, t));
  assert.equal(new Set(sentences).size, sentences.length);
  for (const sentence of sentences) assert.ok(sentence.length > 10, sentence);
});

test("a provider message cannot reach the screen because none is accepted", () => {
  // Broken by: giving `failureMessage` a parameter for the server's text, or
  // rendering `ApiError.message` beside it. Either one lets a provider sentence
  // name the address or speak a language the interface does not.
  assert.equal(failureMessage.length, 2, "failureMessage takes only a code and the copy function");
  const provider = "User already registered";
  assert.equal(
    failureMessage("invalid_credentials", t).includes(provider),
    false,
  );
  // The Czech half is present and is not the English sentence.
  assert.notEqual(
    failureMessage("invalid_credentials", (cs) => cs),
    failureMessage("invalid_credentials", t),
  );
});

test("the account screen and the workspace token gate never say the same thing", () => {
  // Broken by: reusing the gate's copy here, which is how a person ends up
  // reading "Enter the access token for this server" on a form that wants a
  // person, and pasting a machine credential into an email field.
  const copy = accountCopy(t);
  assert.equal(copy.heading, "Sign in to your account.");
  assert.notEqual(copy.heading, "Connect your workspace.");
  assert.notEqual(copy.intro, "Enter the access token for this server.");
  // The screen has to say which credential it is not asking for.
  assert.match(copy.machine, /access token/i);
  assert.match(copy.machine, /not to you|different credential/i);
  // And it must never read the way the machine credential does.
  assert.equal(/access token for this server/i.test(copy.heading + copy.intro), false);
  // The Czech half is written, not a copy of the English one.
  const cs = accountCopy((c) => c);
  for (const key of Object.keys(copy) as (keyof typeof copy)[]) {
    assert.notEqual(cs[key], copy[key], `${key} has no Czech sentence`);
  }
});

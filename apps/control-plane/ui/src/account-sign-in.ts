/**
 * The account sign in screen's decisions, with no React and no DOM in them.
 *
 * The screen is the only place in the interface where a person proves who they
 * are, and it sits beside the workspace access token, which is a machine
 * credential for whoever runs the server. The two are never the same thing, so
 * every sentence here is written to keep them apart, and the copy is exported
 * rather than inlined so a test can hold it to that.
 *
 * Nothing in this file may name the identity provider. `vercel.json` sets
 * `connect-src 'self'`, the browser may only talk to this origin, and both
 * paths below are relative for that reason. A provider call from the browser
 * would put a provider token in the browser, which is the thing the sealed
 * cookie exists to prevent.
 *
 * Every function is pure so `account-sign-in.test.ts` can drive it without a
 * renderer, a DOM or a mocking library.
 */

/** Where the app asks whether there is an account session to reuse. */
export const ACCOUNT_PROBE_PATH = "/api/account";
/** Where a password is posted. The server seals the answer into a cookie. */
export const ACCOUNT_SIGN_IN_PATH = "/api/account/signin";
/** The id of the region that carries whatever the screen last answered. */
export const ACCOUNT_ANSWER_ID = "account-answer";

export type Copy = (cs: string, en: string) => string;
export type FieldName = "email" | "password";
export type FieldErrors = Record<FieldName, string | null>;

/**
 * The five states a visitor can be looking at. `submitting` is not a separate
 * screen so much as the form mid-flight, and `signedIn` outranks it: a person
 * who is already in is never shown a form again because a request is in the air.
 */
export type AccountScreen =
  | "loading"
  | "unconfigured"
  | "signed-out"
  | "submitting"
  | "signed-in";

/**
 * The five failures, named by what the answer meant rather than by the sentence
 * that arrived with it. Nothing here can carry a provider's words, so a failure
 * cannot render one verbatim even if the server were to forward it.
 */
export type AccountFailure =
  | "invalid_credentials"
  | "invite_required"
  | "provider_error"
  | "unreachable"
  | "setup";

/** What the shell shows in place of the workspace once the probe has answered. */
export type GateScreen = "account" | "workspace" | "loading" | "unavailable";

export const noFieldErrors: FieldErrors = { email: null, password: null };

/**
 * The screen a probe answer puts the visitor in.
 *
 * A probe that has not answered yet is `loading` and never a form: rendering a
 * form first and replacing it a moment later is a flash of the wrong question,
 * and on a deployment with no accounts at all the wrong question is the access
 * token, which asks a person for a machine credential.
 */
export function accountScreen(
  probe: { configured?: boolean; signedIn?: boolean } | undefined,
  busy = false,
): AccountScreen {
  if (!probe) return "loading";
  if (probe.configured !== true) return "unconfigured";
  if (probe.signedIn === true) return "signed-in";
  return busy ? "submitting" : "signed-out";
}

/**
 * Which screen the shell shows while the workspace is refusing requests.
 *
 * `pending` outranks everything, then a deployment that is answering 503 for
 * every path including this one, then a deployment that has accounts. Anything
 * else is a deployment with a control token and no accounts, which is the
 * operator's workspace and keeps the token gate it has always had.
 */
export function gateScreen(probe: {
  pending?: boolean;
  configured?: boolean;
  status?: number;
}): GateScreen {
  if (probe.pending) return "loading";
  if (probe.status === 503) return "unavailable";
  if (probe.configured === true) return "account";
  return "workspace";
}

/** An address, and nothing that a provider would have to be asked about. */
const ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * What is wrong with each field, in the screen's own words.
 *
 * The email is checked for shape and the password for emptiness, and nothing
 * here says whether an address holds an account. That answer belongs to the
 * provider and only the provider gets to have it.
 */
export function fieldErrors(
  email: string,
  password: string,
  t: Copy,
): FieldErrors {
  const address = email.trim();
  return {
    email: !address
      ? t("Zadejte svůj e-mail.", "Enter your email address.")
      : ADDRESS.test(address)
        ? null
        : t(
            "Zadejte e-mail ve tvaru jmeno@priklad.cz.",
            "Enter an email address like name@example.com.",
          ),
    password: password
      ? null
      : t("Zadejte své heslo.", "Enter your password."),
  };
}

/**
 * The first field that is wrong, in the order a person reads the form.
 *
 * `null` means nothing is broken, and the caller sends focus to whatever
 * answered instead.
 */
export function firstBrokenField(
  errors: FieldErrors,
): FieldName | null {
  return errors.email ? "email" : errors.password ? "password" : null;
}

/**
 * The id that should hold focus after the screen answered.
 *
 * A broken field gets focus because that is the thing to fix. Otherwise focus
 * goes to the region that carries the sentence, so a screen reader lands on
 * the answer rather than on the top of a form the visitor has already read.
 * `answered` is what keeps focus still before there is anything to read: a
 * form that pulls focus into an empty region the moment it paints is a form
 * that moves the caret out from under the visitor. While an answer is in
 * flight nothing moves either, because a half typed password must not lose the
 * focus it already has.
 */
export function focusTarget(
  errors: FieldErrors,
  screen: AccountScreen,
  answered: boolean,
): string | null {
  const broken = firstBrokenField(errors);
  if (broken) return `account-${broken}`;
  if (screen === "submitting" || !answered) return null;
  return ACCOUNT_ANSWER_ID;
}


/**
 * The body of a sign in, and the whole of it.
 *
 * Two keys, named here rather than assembled at the call site. A magic link, an
 * invitation code or a signup flag added to this object would be a feature the
 * broker does not offer behind this route, so the test pins the key set.
 */
export function signInBody(
  email: string,
  password: string,
): { email: string; password: string } {
  return { email: email.trim(), password };
}

/**
 * What a status means, from the status alone.
 *
 * `undefined` is a failure with no status: a refused connection, a timeout or a
 * body that never parsed. All of them are the same to a person, so they are one
 * failure here rather than three different sentences about a network.
 */
export function classifyFailure(status: number | undefined): AccountFailure {
  if (status === 401) return "invalid_credentials";
  if (status === 403) return "invite_required";
  if (status === 502) return "provider_error";
  if (status === 503) return "setup";
  return "unreachable";
}

/**
 * The sentence for a failure, in this screen's words.
 *
 * A wrong password and an address that holds no account are one sentence, and
 * so is a provider that was careless enough to name the address. There is no
 * parameter for a provider's message, which is the reason that is true.
 */
export function failureMessage(failure: AccountFailure, t: Copy): string {
  const sentences: Record<AccountFailure, [string, string]> = {
    invalid_credentials: [
      "E-mail a heslo nebyly přijaty.",
      "That email and password were not accepted.",
    ],
    // While signup is off a mistyped password for an account that does exist
    // arrives here as well, so this says the sign in was not accepted and then
    // says what is true about the server. Telling the person their address is
    // not invited is a guess, and it is the guess that sends an existing member
    // looking for an invitation they never needed.
    invite_required: [
      "E-mail a heslo nebyly přijaty. Tento server nevytváří nové účty.",
      "That email and password were not accepted. This server does not create new accounts.",
    ],
    provider_error: [
      "Služba přihlášení neodpověděla. Zkuste to za chvíli.",
      "The sign in service could not be reached. Try again shortly.",
    ],
    unreachable: [
      "Účet se nepodařilo ověřit. Zkuste to znovu.",
      "The account could not be verified. Try again.",
    ],
    setup: [
      "Přihlášení na tento server se právě nastavuje.",
      "Sign in on this server is being set up.",
    ],
  };
  const [cs, en] = sentences[failure];
  return t(cs, en);
}

/**
 * Every sentence the screen can show, in one place.
 *
 * `machine` is the load-bearing one. A person reading this screen has to be
 * able to tell at a glance that the access token they may have been given
 * earlier is not what this form wants, or they will paste a token into an
 * email field and conclude the account is broken.
 */
export function accountCopy(t: Copy) {
  return {
    heading: t("Přihlaste se ke svému účtu.", "Sign in to your account."),
    intro: t(
      "Toto je váš účet NOMO. Pozná vás e-mail a heslo.",
      "This is your NOMO account. You are recognised by your email and password.",
    ),
    machine: t(
      "Přístupový token pro pracovní prostor je jiná věc: patří tomu, kdo tento server provozuje, ne vám. Tento formulář token nechce.",
      "The workspace access token is a different credential: it belongs to whoever runs this server, not to you. This form does not want it.",
    ),
    email: t("E-mail", "Email"),
    password: t("Heslo", "Password"),
    submit: t("Přihlásit se", "Sign in"),
    busy: t("Přihlašuji se…", "Signing in…"),
    loading: t("Ověřuji přihlášení…", "Checking your sign in…"),
    signedIn: t("Jste přihlášeni.", "You are signed in."),
    signedInNote: t(
      "Účet byl potvrzen u poskytovatele identity.",
      "The account was confirmed by the identity provider.",
    ),
    signOut: t("Odhlásit se", "Sign out"),
    unconfigured: t(
      "Na tomto serveru nejsou účty nastaveny. Použijte přístupový token pro pracovní prostor.",
      "This server has no accounts configured. Use the workspace access token instead.",
    ),
    unavailable: t(
      "Přihlášení na tento server se právě nastavuje.",
      "Sign in on this server is being set up.",
    ),
  };
}

import { useEffect, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { api, ApiError, type Row } from "./api";
import { BrandMark } from "./brand";
import {
  ACCOUNT_ANSWER_ID,
  ACCOUNT_PROBE_PATH,
  ACCOUNT_SIGN_IN_PATH,
  accountCopy,
  accountScreen,
  classifyFailure,
  failureMessage,
  fieldErrors,
  focusTarget,
  noFieldErrors,
  signInBody,
  type AccountFailure,
  type FieldErrors,
} from "./account-sign-in";
import { useText } from "./ui";

/**
 * The sign in screen for a person, beside the workspace token gate that asks a
 * machine for a machine.
 *
 * The screen is reached when this deployment has accounts and the visitor has
 * no session for one. Password is the only way in: the broker behind
 * `/api/account/signin` offers no magic link, no signup and no social sign in
 * behind that route, and a control this screen cannot complete is worse than a
 * control it does not offer.
 *
 * Two rules shape the markup. Focus always lands somewhere meaningful, on the
 * first field that is wrong and otherwise on the region that carries the
 * sentence, so a screen reader hears the answer rather than re-reading the
 * form. And a failure is rendered from a code in this repository's own words:
 * the provider's message is never shown, because a provider message can name
 * whether an address holds an account and can say things in a language the
 * rest of this interface does not speak.
 */
export function AccountSignIn({
  probe,
  queryClient,
}: {
  probe: Row | undefined;
  queryClient: QueryClient;
}) {
  const t = useText();
  const copy = accountCopy(t);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>(noFieldErrors);
  const [failure, setFailure] = useState<AccountFailure | null>(null);
  const [busy, setBusy] = useState(false);
  // The address the answer confirmed, so the signed in screen can name the
  // person without holding the password or anything else the form collected.
  // It is read from the probe on every render rather than copied into state by
  // an effect: state set in an effect paints a frame with the name missing.
  const [justSignedInAs, setJustSignedInAs] = useState<string | null>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const screen = accountScreen(probe, busy);
  const signedInAs =
    typeof probe?.email === "string" ? probe.email : justSignedInAs;

  // Focus follows the answer. The pure function decides where, and it answers
  // nothing before there is a sentence to read, so the form never pulls focus
  // away from a visitor who is still typing into it.
  useEffect(() => {
    const target = focusTarget(
      errors,
      screen,
      failure !== null || screen === "signed-in",
    );
    if (!target) return;
    const node =
      target === ACCOUNT_ANSWER_ID
        ? answerRef.current
        : document.getElementById(target);
    node?.focus();
  }, [errors, screen, failure]);

  async function signIn() {
    const found = fieldErrors(email, password, t);
    setErrors(found);
    setFailure(null);
    if (found.email || found.password) return;
    setBusy(true);
    try {
      await api(ACCOUNT_SIGN_IN_PATH, "POST", signInBody(email, password));
      setPassword("");
      setJustSignedInAs(email.trim());
      // The cookie is sealed and set. The provider probe that gated this screen
      // has to run again before the workspace will be served.
      await queryClient.invalidateQueries();
    } catch (e) {
      // Only the status is read. Whatever sentence arrived with the refusal is
      // dropped on the floor and replaced by one written here.
      setFailure(
        classifyFailure(e instanceof ApiError ? e.status : undefined),
      );
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      await api(ACCOUNT_PROBE_PATH, "DELETE");
      setJustSignedInAs(null);
      await queryClient.invalidateQueries();
    } catch {
      setFailure("unreachable");
    } finally {
      setBusy(false);
    }
  }

  if (screen === "loading")
    return (
      <div className="connection-gate account-gate">
        <div className="account-answer" role="status">
          {copy.loading}
        </div>
      </div>
    );

  if (screen === "unconfigured")
    return (
      <div className="connection-gate account-gate">
        <BrandMark className="gate-logo" />
        <div className="account-answer" role="status">
          {copy.unconfigured}
        </div>
      </div>
    );

  if (screen === "signed-in")
    return (
      <div className="connection-gate account-gate">
        <BrandMark className="gate-logo" />
        <h1>{copy.signedIn}</h1>
        {signedInAs && (
          <p className="account-identity">
            <span className="sr-only">{copy.email}: </span>
            {signedInAs}
          </p>
        )}
        <div
          className="account-answer"
          id={ACCOUNT_ANSWER_ID}
          ref={answerRef}
          tabIndex={-1}
          role="status"
        >
          {failure ? (
            <span className="error-text">{failureMessage(failure, t)}</span>
          ) : (
            copy.signedInNote
          )}
        </div>
        <button className="primary" onClick={signOut} disabled={busy}>
          {copy.signOut}
        </button>
      </div>
    );

  const describedBy = (field: "email" | "password") =>
    errors[field] ? `account-${field}-error` : undefined;

  const clearOnEdit = () => {
    if (errors.email || errors.password) setErrors(noFieldErrors);
    if (failure) setFailure(null);
  };

  return (
    <div className="connection-gate account-gate">
      <BrandMark className="gate-logo" />
      <h1>{copy.heading}</h1>
      <p>{copy.intro}</p>
      <p className="account-machine">{copy.machine}</p>
      <form
        noValidate
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          void signIn();
        }}
      >
        <label>
          {copy.email}
          <input
            id="account-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={describedBy("email")}
            onChange={(e) => {
              setEmail(e.target.value);
              clearOnEdit();
            }}
          />
        </label>
        {errors.email && (
          <p className="field-error" id="account-email-error">
            {errors.email}
          </p>
        )}
        <label>
          {copy.password}
          <input
            id="account-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={describedBy("password")}
            onChange={(e) => {
              setPassword(e.target.value);
              clearOnEdit();
            }}
          />
        </label>
        {errors.password && (
          <p className="field-error" id="account-password-error">
            {errors.password}
          </p>
        )}
        <div
          className="account-answer"
          id={ACCOUNT_ANSWER_ID}
          ref={answerRef}
          tabIndex={-1}
          role="status"
        >
          {failure ? (
            <span className="error-text">{failureMessage(failure, t)}</span>
          ) : null}
        </div>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? copy.busy : copy.submit}
        </button>
      </form>
    </div>
  );
}

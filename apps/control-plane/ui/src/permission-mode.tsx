/** Visible permission modes. The server is the sole authority: it filters
 * the tool catalog and refuses every state-changing mutation. The banner and
 * prompt prefix are explanations, never the enforcement point. */
import type { Row } from "./api";
import { useText } from "./ui";

export type PermissionMode = "plan" | "read-only" | "normal";
/** Where the mode came from. `pending` is not an authority: the capabilities
 * query has not answered yet, so the mode is the fail-closed default and the
 * client claims nothing about what the server would allow. */
export type PermissionSource = "server" | "local" | "pending";

/** The capabilities query, as far as the mode resolver needs to see it.
 * `isPending` with no data is a request in flight; `isError` is a request that
 * came back with nothing usable. The two are different claims. */
export type PermissionQuery = {
  readonly data?: Row;
  readonly isPending?: boolean;
  readonly isError?: boolean;
};

export type PermissionModeState = {
  readonly mode: PermissionMode;
  readonly source: PermissionSource;
  /** Absent when the client cannot set the mode at all, which is the normal
   * case. A caller that receives `undefined` here has to render a status, not a
   * control: a control that cannot change anything is not a control. */
  readonly setMode?: (mode: PermissionMode) => void;
};
export function resolvePermissionMode(capabilities: PermissionQuery): {
  readonly mode: PermissionMode;
  readonly source: PermissionSource;
} {
  const data = capabilities.data;
  if (data === undefined) {
    // "The server has not answered" and "the server answered and did not
    // authorise a mode" are different statements, and only the second one
    // licenses naming the server as the reason. The mode itself stays the
    // fail-closed default either way: a pending query never buys privilege.
    const answered = capabilities.isError === true || capabilities.isPending === false;
    return { mode: "read-only", source: answered ? "local" : "pending" };
  }
  const mode = data.permissionMode;
  if (data.permissionModeAuthority === "server" && (mode === "plan" || mode === "read-only" || mode === "normal"))
    return { mode, source: "server" };
  return { mode: "read-only", source: "local" };
}

/** The server capability is authoritative. This hook intentionally does not
 * read or write local preferences: a client cannot grant itself permission.
 * There is consequently no setter — a no-op function would only let a caller
 * render a switch that looks operable and is not. */
export function usePermissionMode(
  capabilities: PermissionQuery,
  _preferences?: { data?: Row },
): PermissionModeState {
  return resolvePermissionMode(capabilities);
}

/** The mode prefix is a prompt instruction, not a local block.
 *
 * It reads only the mode, so it says "read-only" during the capabilities
 * flight window as well. That is deliberate: dropping the prefix while the
 * answer is unknown would instruct the model that it may act before the server
 * has granted anything, which is the direction this component must never err
 * in. Removing it would mean threading the resolved source into this call
 * site, and the server still enforces independently of the wording. */
export function modePrefix(mode: PermissionMode, t: (cs: string, en: string) => string): string {
  if (mode === "plan")
    return t(
      "Plánuj pouze. Popiš kroky a dokumenty, které by se změnily. Zatím nežádej o nástroje měnící stav.\n\n",
      "Plan only. Describe the steps and the documents that would change. Do not request state changing tools yet.\n\n",
    );
  if (mode === "read-only")
    return t(
      "Jen čtení. Prohlížej a vysvětluj; neměň žádný stav.\n\n",
      "Read-only. Inspect and explain; do not change any state.\n\n",
    );
  return "";
}

const MODES: readonly PermissionMode[] = ["normal", "plan", "read-only"];

/** The one wording for "which mode, and who is enforcing it". The banner and
 * the non-interactive switch both read it, so the two cannot drift apart and
 * the composer cannot show one sentence in the notices and another in the
 * settings dialog. */
function modeWords(
  mode: PermissionMode,
  source: PermissionSource,
  t: (cs: string, en: string) => string,
): { readonly label: string; readonly origin: string } {
  const label =
    mode === "plan"
      ? t("Režim: plán", "Mode: plan")
      : mode === "read-only"
        ? t("Režim: jen čtení", "Mode: read-only")
        : t("Režim: normální", "Mode: normal");
  const origin =
    source === "server"
      ? t("vynucuje server", "enforced by server")
      : source === "pending"
        ? t("režim se ověřuje u serveru", "checking the server")
        : t("server mode unavailable — read-only fallback", "server mode unavailable — read-only fallback");
  return { label, origin };
}

export function PermissionModeSwitch({
  mode,
  source,
  onChange,
}: {
  mode: PermissionMode;
  source: PermissionSource;
  onChange?: (mode: PermissionMode) => void;
}) {
  const t = useText();
  const words = modeWords(mode, source, t);
  return (
    <div className="permission-modes">
      {onChange ? (
        <div
          role="radiogroup"
          aria-label={t("Režim oprávnění", "Permission mode")}
          data-source={source}
        >
          {MODES.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              onClick={() => onChange(id)}
              className={"permission-mode" + (mode === id ? " active" : "")}
            >
              {id === "normal"
                ? t("Normální", "Normal")
                : id === "plan"
                  ? t("Plán", "Plan")
                  : t("Jen čtení", "Read-only")}
            </button>
          ))}
        </div>
      ) : (
        // No setter, so no radiogroup. A group whose every radio is disabled
        // announces the authoritative mode as unselectable — the one thing it
        // actually is not — so the mode is stated as text and the rail on the
        // banner carries the source, as it does everywhere else.
        <p className="muted">
          {words.label} · {words.origin}
        </p>
      )}
      {onChange ? null : (
        <p className="muted">
          {t("Server určuje režim; tuto volbu nelze změnit.", "Server controls this mode; it cannot be changed here.")}
        </p>
      )}
    </div>
  );
}

/** The mode banner labels the active mode and its enforcement source. The
 * server stays authoritative; a local preset announces itself as unenforced. */
export function PermissionBanner({
  mode,
  source,
}: {
  mode: PermissionMode;
  source: PermissionSource;
}) {
  const t = useText();
  const { label, origin } = modeWords(mode, source, t);
  return (
    <p className="permission-banner" role="status" data-mode={mode} data-source={source}>
      {label} · {origin}
    </p>
  );
}

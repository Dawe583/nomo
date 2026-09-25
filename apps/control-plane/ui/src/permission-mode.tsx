/** Visible permission modes. The server is the sole authority: it filters
 * the tool catalog and refuses every state-changing mutation. The banner and
 * prompt prefix are explanations, never the enforcement point. */
import type { Row } from "./api";
import { useText } from "./ui";

export type PermissionMode = "plan" | "read-only" | "normal";
export type PermissionSource = "server" | "local";

export type PermissionModeState = {
  readonly mode: PermissionMode;
  readonly source: PermissionSource;
  readonly setMode: (mode: PermissionMode) => void;
};
export function resolvePermissionMode(data: Row | undefined): {
  readonly mode: PermissionMode;
  readonly source: PermissionSource;
} {
  const mode = data?.permissionMode;
  if (data?.permissionModeAuthority === "server" && (mode === "plan" || mode === "read-only" || mode === "normal"))
    return { mode, source: "server" };
  return { mode: "read-only", source: "local" };
}

/** The server capability is authoritative. This hook intentionally does not
 * read or write local preferences: a client cannot grant itself permission. */
export function usePermissionMode(
  capabilities: { data?: Row },
  _preferences?: { data?: Row },
): PermissionModeState {
  const resolved = resolvePermissionMode(capabilities.data);
  return {
    ...resolved,
    setMode: () => undefined,
  };
}

/** The mode prefix is a prompt instruction, not a local block. */
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

const MODES: readonly { readonly id: PermissionMode; readonly label: string }[] = [
  { id: "normal", label: "Normal" },
  { id: "plan", label: "Plan" },
  { id: "read-only", label: "Read-only" },
];

export function PermissionModeSwitch({
  mode,
  source,
  onChange,
}: {
  mode: PermissionMode;
  source: PermissionSource;
  onChange: (mode: PermissionMode) => void;
}) {
  const t = useText();
  return (
    <div className="permission-modes" role="radiogroup" aria-disabled="true" aria-label={t("Režim oprávnění", "Permission mode")}>
      {MODES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="radio"
          aria-checked={mode === entry.id}
          disabled
          className={"permission-mode" + (mode === entry.id ? " active" : "")}
          data-source={source}
        >
          {entry.id === "normal"
            ? t("Normální", "Normal")
            : entry.id === "plan"
              ? t("Plán", "Plan")
              : t("Jen čtení", "Read-only")}
        </button>
      ))}
      <p className="muted permission-authority">
        {t("Server určuje režim; tuto volbu nelze změnit.", "Server controls this mode; it cannot be changed here.")}
      </p>
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
  const label =
    mode === "plan"
      ? t("Režim: plán", "Mode: plan")
      : mode === "read-only"
        ? t("Režim: jen čtení", "Mode: read-only")
        : t("Režim: normální", "Mode: normal");
  const origin =
    source === "server"
      ? t("vynucuje server", "enforced by server")
      : t("server mode unavailable — read-only fallback", "server mode unavailable — read-only fallback");
  return (
    <p className="permission-banner" role="status" data-mode={mode} data-source={source}>
      {label} · {origin}
    </p>
  );
}

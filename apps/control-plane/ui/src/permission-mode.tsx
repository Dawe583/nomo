/** Visible permission modes. The server stays authoritative; a local preset is
 * only a prompt prefix, never a local enforcement block. */
import type { Row } from "./api";
import { useText } from "./ui";

export type PermissionMode = "plan" | "read-only" | "normal";
export type PermissionSource = "server" | "local";

export type PermissionModeState = {
  readonly mode: PermissionMode;
  readonly source: PermissionSource;
  readonly setMode: (mode: PermissionMode) => void;
};

/** Resolve the visible mode: the server readiness wins; the local preference is
 * a fallback that labels itself as unenforced. */
export function usePermissionMode(
  capabilities: { data?: Row },
  preferences: { data?: Row },
): PermissionModeState {
  const serverMode = serverReadinessMode(capabilities.data);
  const localMode = localPresetMode(preferences.data);
  const mode = serverMode ?? localMode ?? "normal";
  const source: PermissionSource = serverMode !== undefined ? "server" : "local";
  const setMode = (next: PermissionMode) => {
    // The local preset is data, never code. Server enforcement stays authoritative.
    void fetch("/api/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferences: { permissionMode: next } }),
    }).catch(() => undefined);
  };
  return { mode, source, setMode };
}

function serverReadinessMode(data: Row | undefined): PermissionMode | undefined {
  const readiness = data?.readiness;
  if (readiness === "read-only") return "read-only";
  if (readiness === "plan") return "plan";
  return undefined;
}

function localPresetMode(data: Row | undefined): PermissionMode | undefined {
  const mode = data?.preferences?.permissionMode;
  return mode === "plan" || mode === "read-only" || mode === "normal" ? mode : undefined;
}

/** The mode prefix is a prompt instruction, not a local block. */
export function modePrefix(mode: PermissionMode, t: (cs: string, en: string) => string): string {
  if (mode === "plan")
    return t(
      "Plan only. Describe the steps and the documents that would change. Do not request state changing tools yet.\n\n",
      "Plan only. Describe the steps and the documents that would change. Do not request state changing tools yet.\n\n",
    );
  if (mode === "read-only")
    return t(
      "Read-only. Inspect and explain; do not change any state.\n\n",
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
  return (
    <div className="permission-modes" role="radiogroup" aria-label="Permission mode">
      {MODES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="radio"
          aria-checked={mode === entry.id}
          className={"permission-mode" + (mode === entry.id ? " active" : "")}
          data-source={source}
          onClick={() => onChange(entry.id)}
        >
          {entry.label}
        </button>
      ))}
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
      : t("místní předvolba — nevynuceno", "local preset — not enforced");
  return (
    <p className="permission-banner" role="status" data-mode={mode} data-source={source}>
      {label} · {origin}
    </p>
  );
}

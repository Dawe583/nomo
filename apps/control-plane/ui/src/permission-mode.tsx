import { useCallback, useId, useRef, useState } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { api, type Row } from "./api";
import { useText } from "./ui";
import {
  PERMISSION_MODES,
  isPermissionMode,
  modeIntent,
  modeLabel,
  restrictsWrites,
  type PermissionMode,
  type PermissionModeSource,
} from "./permission-modes.ts";

export {
  modePrefix,
  PERMISSION_MODES,
  isPermissionMode,
  restrictsWrites,
  type PermissionMode,
  type PermissionModeSource,
} from "./permission-modes.ts";

const STORAGE_KEY = "void-permission-mode";

/**
 * The capabilities payload carries no permission mode today. gui.ts returns the
 * deployment mode ("local" | "cloud") under `mode`, which says where the runtime
 * runs, not what the agent may write, so it is never read as a permission mode.
 * A server enforced mode has to arrive as its own field: only an explicit one is
 * believed, and until the server sends it the composer says the mode is local.
 */
const ENFORCED_FIELD = "enforcedPermissionMode";

function readEnforcedMode(data: Row | undefined): PermissionMode | null {
  const declared = data?.[ENFORCED_FIELD];
  return isPermissionMode(declared) ? declared : null;
}

function readPreferenceMode(data: Row | undefined): PermissionMode | null {
  const stored = data?.preferences?.permissionMode;
  return isPermissionMode(stored) ? stored : null;
}

function readStoredMode(): PermissionMode | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isPermissionMode(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredMode(mode: PermissionMode | null) {
  try {
    if (mode) localStorage.setItem(STORAGE_KEY, mode);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be refused (private mode, quota). The mode then lives in
    // component state until reload, which is still the browser remembering it.
  }
}

/**
 * Resolves the composer mode and how to change it.
 *
 * Precedence is enforced first, then the choice made in this browser, then the
 * stored preference. The local choice outranks the stored preference so an
 * optimistic change is not snapped back by a preferences read that has not caught
 * up yet.
 */
export function usePermissionMode(
  capabilities: UseQueryResult<Row, Error>,
  preferences: UseQueryResult<Row, Error>,
) {
  const t = useText(),
    client = useQueryClient();
  const enforced = readEnforcedMode(capabilities.data),
    stored = readPreferenceMode(preferences.data);
  const [local, setLocal] = useState<PermissionMode | null>(readStoredMode);
  const [error, setError] = useState<unknown>();
  const source: PermissionModeSource = enforced ? "server" : "local";
  const mode = enforced ?? local ?? stored ?? "normal";
  const setMode = useCallback(
    async (next: PermissionMode) => {
      if (enforced) {
        setError(
          new Error(
            t("Režim nastavuje server.", "This mode is set by the server."),
          ),
        );
        return;
      }
      const previous = local;
      setError(undefined);
      setLocal(next);
      writeStoredMode(next);
      try {
        await api("/api/preferences", "PATCH", { permissionMode: next });
        await client.invalidateQueries({ queryKey: ["/api/preferences"] });
      } catch (e) {
        setLocal(previous);
        writeStoredMode(previous);
        setError(e);
      }
    },
    [client, enforced, local, t],
  );
  return { mode, source, setMode, error };
}

export function PermissionModeSwitch({
  mode,
  source,
  onChange,
}: {
  mode: PermissionMode;
  source: PermissionModeSource;
  onChange: (mode: PermissionMode) => void | Promise<void>;
}) {
  const t = useText(),
    hintId = useId(),
    buttons = useRef<(HTMLButtonElement | null)[]>([]);
  // An enforced mode is not the operator's to change, so the group reports itself
  // unavailable instead of disappearing: aria-disabled keeps every option
  // reachable by keyboard, which is the only way to read the reason beside it.
  const locked = source === "server";
  const move = (from: number, key: string) => {
    const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : -1;
    const target =
      key === "Home"
        ? 0
        : key === "End"
          ? PERMISSION_MODES.length - 1
          : (from + step + PERMISSION_MODES.length) % PERMISSION_MODES.length;
    const next = PERMISSION_MODES[target];
    if (!next) return;
    buttons.current[target]?.focus();
    if (!locked) void onChange(next);
  };
  return (
    <div
      className="perm-switch"
      role="radiogroup"
      aria-label={t("Režim oprávnění", "Permission mode")}
      aria-describedby={locked ? hintId : undefined}
    >
      {PERMISSION_MODES.map((value, index) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={mode === value}
          aria-disabled={locked}
          className={mode === value ? "perm-active" : undefined}
          tabIndex={mode === value ? 0 : -1}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          onClick={() => {
            if (!locked) void onChange(value);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "ArrowRight" ||
              event.key === "ArrowDown" ||
              event.key === "ArrowLeft" ||
              event.key === "ArrowUp" ||
              event.key === "Home" ||
              event.key === "End"
            ) {
              event.preventDefault();
              move(index, event.key);
            }
          }}
        >
          {modeLabel(value, t)}
        </button>
      ))}
      {locked && (
        <span id={hintId} className="perm-source">
          {t("Režim nastavuje server.", "The server sets this mode.")}
        </span>
      )}
    </div>
  );
}

/**
 * The composer is where a hold would otherwise stay hidden, so the banner names
 * the mode in words and states who enforces it. On the local path it says plainly
 * that the server does not enforce the mode and that VOID approval still decides
 * every write, because the switch is a request and not a guarantee.
 */
export function PermissionBanner({
  mode,
  source,
}: {
  mode: PermissionMode;
  source: PermissionModeSource;
}) {
  const t = useText(),
    label = modeLabel(mode, t),
    intent = modeIntent(mode, t);
  return (
    <p className="perm-banner" role="status">
      {t(`Režim: ${label} (${intent}).`, `Mode: ${label} (${intent}).`)}{" "}
      {source === "server"
        ? restrictsWrites(mode)
          ? t(
              "Server tento režim nastavuje a vynucuje, takže zápisy mimo režim odmítne.",
              "The server sets and enforces this mode, so it refuses writes outside it.",
            )
          : t(
              "Server tento režim nastavuje a vynucuje.",
              "The server sets and enforces this mode.",
            )
        : t(
            "Server tento režim nevynucuje. Je to pokyn vložený do vaší zprávy a každý zápis stále schvaluje VOID. Volbu si pamatuje jen tento prohlížeč.",
            "The server does not enforce this mode. It is an instruction inside your message, and VOID approval still decides every write. Only this browser remembers the choice.",
          )}
    </p>
  );
}

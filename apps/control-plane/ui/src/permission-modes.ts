/**
 * Permission mode vocabulary, shared by the composer switch, the banner and the
 * prompt prefix.
 *
 * A .ts module on purpose: node:test cannot load a .tsx file, because type
 * stripping has no JSX transform, so `import "./permission-mode.tsx"` fails with
 * ERR_UNKNOWN_FILE_EXTENSION. Everything pure and worth asserting lives here and
 * is re-exported from the component module, so chat.tsx keeps importing one path.
 */

/** Plan, Read-only and Normal, as UPGRADE-PLAN-NEXT-2026-09-18.md item B5 names them. */
export type PermissionMode = "plan" | "read-only" | "normal";

/** Where the mode's authority comes from. "server" is reserved for a mode the server declares and enforces. */
export type PermissionModeSource = "server" | "local";

/** The shape useText() returns: Czech first, English second, English is the default locale. */
export type Translate = (cs: string, en: string) => string;

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "plan",
  "read-only",
  "normal",
];

/** Narrows an untrusted value, so a capabilities or preferences payload can name a mode without inventing one. */
export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}

/** Plan and read-only ask for fewer writes. Normal asks for nothing in particular. */
export function restrictsWrites(mode: PermissionMode): boolean {
  return mode !== "normal";
}

export function modeLabel(mode: PermissionMode, t: Translate): string {
  if (mode === "read-only") return t("Jen čtení", "Read-only");
  if (mode === "plan") return t("Plán", "Plan");
  return t("Normální", "Normal");
}

/** The one clause that says, in words, what the mode asks of the agent. */
export function modeIntent(mode: PermissionMode, t: Translate): string {
  if (mode === "read-only")
    return t("bez jakýchkoli změn", "no changes at all");
  if (mode === "plan")
    return t(
      "nejprve návrh, poté čeká na schválení",
      "propose first, then wait for approval",
    );
  return t("změny povoleny", "changes allowed");
}

/**
 * The mode reaches the agent only as text prepended to the prompt, so every
 * sentence here has to stay a request. A prefix that announced a blocked write
 * would be a claim nothing enforces: the server does not read the mode and policy
 * decides each write on its own case.
 */
export function modePrefix(mode: PermissionMode, t: Translate): string {
  const instruction =
    mode === "read-only"
      ? t(
          "Režim jen čtení: nic neměň, jen čti a popiš, co jsi našel.",
          "Read-only mode: change nothing. Read and report what you find.",
        )
      : mode === "plan"
        ? t(
            "Režim plán: nejprve navrhni plán, upozorni na rizika a počkej na mé schválení. Změny zatím neprováděj.",
            "Plan mode: propose a plan first, name the risks and wait for my approval. Make no changes yet.",
          )
        : t(
            "Režim normální: pracuj běžným způsobem.",
            "Normal mode: work as usual.",
          );
  // chat.tsx concatenates this straight onto the draft, so the instruction ends
  // its own block instead of running into the first word the user typed.
  return instruction + "\n\n";
}

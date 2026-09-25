/**
 * WP-R02 legacy host binding envelope.
 *
 * Deliberately not a before-image. `REVERSE-ENGINE-VALIDATION.md` records that
 * the proxy stopped auto calling connector capture, so a signed allow is
 * permission, not proof that a write happened or that an inverse exists. What
 * this binds is the call envelope the ledger already names, so a dispatch can
 * later be matched against the decision that authorised it. Producing a
 * before-image here would advertise a recovery capability this path does not
 * have, which is the one thing `RECOVERY-CONTRACT.md` calls out as the
 * difference between a registry entry and a working inverse.
 *
 * `argsDigest` is byte-identical to the `argsDigest` written on the ledger
 * entry for the same call, because that is the whole point of the binding: an
 * auditor holding an entry can recompute the envelope from the recorded
 * arguments and see whether the forwarded call was the allowed one. The scheme
 * is therefore `sha256(JSON.stringify(args))` as `forward/tools.ts` uses, not
 * the canonicaliser; switching it here would silently orphan every entry
 * already written.
 */

import { createHash } from "node:crypto";

export const LEGACY_BINDING_SCHEMA = "void.legacy.binding.v1";

/**
 * What the envelope can and cannot promise. `envelope-only` is the honest
 * answer for every legacy tool: the proxy holds permission and a decision, not
 * a before image. A host that really did capture a before image returns it
 * through `captureLegacyEnvelope`'s caller, never by editing this field.
 */
export type LegacyBindingKind = "envelope-only" | "host-captured";

export type LegacyBindingEnvelope = {
  readonly schema: typeof LEGACY_BINDING_SCHEMA;
  readonly tool: string;
  readonly connector: string;
  readonly workspace: string;
  readonly argsDigest: string;
  readonly boundAt: string;
  readonly binding: LegacyBindingKind;
  /** Always null here. An inverse is proven by a recovery receipt, never by an envelope. */
  readonly inverse: null;
  readonly reversible: false;
};

/** Registry ids and workspace names are bounded and printable. */
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const WORKSPACE = /^[\w.:-]{1,200}$/;
const CONNECTOR = /^[\w.:-]{1,100}$/;

const argsDigest = (args: Readonly<Record<string, unknown>>): string =>
  createHash("sha256").update(JSON.stringify(args)).digest("hex");

/**
 * The connector a tool id claims, taken from the id's own vendor prefix. It is
 * a label for the operator, not a capability: an id may name a connector that
 * has no adapter, which is precisely why `reversible` is a constant false.
 */
function connectorOf(tool: string): string {
  const vendor = tool.startsWith("aws.s3.") ? "s3" : (tool.split(".")[0] ?? "");
  return CONNECTOR.test(vendor) ? vendor : "unknown";
}

/**
 * Rejects rather than returns a partial envelope. The caller in
 * `forward/tools.ts` turns a throw into a local deny and never contacts the
 * upstream, so a malformed identity is refused before dispatch instead of being
 * forwarded under an unverifiable name.
 *
 * The thrown messages name the field and never echo the argument value: tool
 * arguments carry customer rows and connection strings, and an error string
 * reaches the agent that made the call.
 */
export async function captureLegacyEnvelope(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  workspace: string,
): Promise<LegacyBindingEnvelope> {
  if (typeof tool !== "string" || !ID.test(tool))
    throw new Error(
      "legacy binding refused: tool id is not a printable registry id",
    );
  if (typeof workspace !== "string" || !WORKSPACE.test(workspace))
    throw new Error("legacy binding refused: workspace is not a valid name");
  if (typeof args !== "object" || args === null || Array.isArray(args))
    throw new Error("legacy binding refused: arguments are not an object");
  // A value that cannot round trip through JSON would produce an envelope that
  // no auditor can recompute from the ledger, which is the failure this whole
  // module exists to prevent.
  const serialised = JSON.stringify(args);
  if (serialised === undefined)
    throw new Error(
      "legacy binding refused: arguments do not round trip as JSON",
    );
  return {
    schema: LEGACY_BINDING_SCHEMA,
    tool,
    connector: connectorOf(tool),
    workspace,
    argsDigest: argsDigest(args),
    boundAt: new Date().toISOString(),
    binding: "envelope-only",
    inverse: null,
    reversible: false,
  };
}

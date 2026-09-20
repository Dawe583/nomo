/** WP-R02 capture gate for the legacy stdio/http host: a durable envelope
 * snapshot that completes before the proxy forwards upstream. Raw arguments
 * never enter the envelope; the digest is the evidence, secrets stay out. */
import { canonicalJson } from "../../../ledger/src/canonical.ts";
import { sha256Hex } from "../../../ledger/src/sign.ts";

export type LegacyEnvelope = {
  readonly schema: "void.legacy.envelope.v1";
  readonly at: string;
  readonly tool: string;
  readonly workspace?: string;
  readonly argsDigest: string;
};

export async function captureLegacyEnvelope(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  workspace?: string,
): Promise<LegacyEnvelope> {
  const argsDigest = await sha256Hex(canonicalJson(args));
  return {
    schema: "void.legacy.envelope.v1",
    at: new Date().toISOString(),
    tool,
    workspace,
    argsDigest,
  };
}

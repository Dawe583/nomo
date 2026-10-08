/**
 * Token issuance and verification, contract docs/nomo/CONTRACT.md section 5,
 * steps 1 to 3 and the signature half of step 5.
 *
 * The encoding is a spike proposal for [DAVID], kept in this one module so a
 * different choice replaces this file and nothing else. It signs with VOID's
 * own `KeyProvider`, the interface the ledger already uses, so a dev key, a
 * retained key and a future KMS all work unchanged.
 *
 * Wire form: `<payload>.<signature>`, both base64url. The payload is canonical
 * JSON of `{ v, alg, kid, claims }`. The signature covers a domain separated
 * preimage, so a token cannot be replayed as a ledger signature or the other
 * way round, even under the same key.
 *
 * The token value is a bearer credential: nothing here logs it, and a
 * verification failure never echoes it back. Only `jti` is ever printed.
 */

import { randomUUID } from "node:crypto";

import type { Alg, KeyProvider } from "../../ledger/src/index.ts";
import { canonicalJson, verifySignature } from "../../ledger/src/sign.ts";
import { AGENT_ID, BUILTIN_RULES, isScope } from "./grammar.ts";
import {
  checkPolicy,
  POLICY_CHECK_CONTRACT,
  type CheckDeps,
  type PolicyCheckRequest,
  type PolicyCheckResult,
} from "./check.ts";
import { TOKEN_TTL_SECONDS, type TokenClaims } from "./revocations.ts";

export const TOKEN_FORMAT = "nomo.token.v0" as const;

/** Long enough for every legal claim set, short enough to refuse a flood before parsing it. */
export const MAX_TOKEN_LENGTH = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The bytes a token signature covers. The format tag is the domain separator. */
export function tokenSigningPreimage(payloadB64: string): Uint8Array {
  return encoder.encode(`${TOKEN_FORMAT}\n${payloadB64}`);
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function fromBase64url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  // Buffer decodes leniently; a value that does not round trip is not ours.
  return bytes.toString("base64url") === text ? new Uint8Array(bytes) : null;
}

export type SignedToken = {
  /** The bearer value. Hand it to the agent; never log it. */
  readonly value: string;
  readonly claims: TokenClaims;
  readonly keyId: string;
};

/** Signs claims as a token. Refuses claims a verifier would refuse. */
export async function signToken(
  claims: TokenClaims,
  signer: KeyProvider,
): Promise<SignedToken> {
  const problem = claimsProblem(claims);
  if (problem !== null) throw new TypeError(`token claims: ${problem}`);
  const kid = await signer.currentKeyId();
  const payload = Buffer.from(
    canonicalJson({ v: TOKEN_FORMAT, alg: signer.alg, kid, claims }),
    "utf8",
  ).toString("base64url");
  const signature = await signer.sign(tokenSigningPreimage(payload), kid);
  const value = `${payload}.${Buffer.from(signature).toString("base64url")}`;
  if (value.length > MAX_TOKEN_LENGTH)
    throw new TypeError(`token claims: token is longer than ${MAX_TOKEN_LENGTH}`);
  return { value, claims, keyId: kid };
}

export type TokenVerifier = {
  /** SPKI DER for a key id this verifier trusts, or null for any other. */
  readonly publicKey: (keyId: string) => Promise<Uint8Array | null>;
  /** The one algorithm accepted. A token naming another is refused, never downgraded. */
  readonly alg: Alg;
};

/** A verifier over the same key ring that signs, which is the spike setup. */
export const verifierFor = (provider: KeyProvider): TokenVerifier => ({
  publicKey: (keyId) => provider.publicKey(keyId),
  alg: provider.alg,
});

export type VerifiedToken =
  | { readonly ok: true; readonly claims: TokenClaims; readonly keyId: string }
  | { readonly ok: false; readonly ruleId: string; readonly reason: string };

const CLAIM_KEYS = [
  "agentId",
  "agentPolicyDigest",
  "exp",
  "iat",
  "jti",
  "scope",
  "target",
  "tool",
  "workspace",
] as const;

const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const nonEmpty = (value: unknown, max: number): boolean =>
  typeof value === "string" && value !== "" && value.length <= max;

/**
 * Shape only: a closed key set and types. Expiry, revocation and whether the
 * token covers the call are `checkTokenClaims`, which runs inside the engine.
 */
function claimsProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "claims must be an object";
  const claims = value as Record<string, unknown>;
  const keys = Object.keys(claims).sort();
  if (
    keys.length !== CLAIM_KEYS.length ||
    keys.some((key, i) => key !== CLAIM_KEYS[i])
  )
    return `claims must have exactly ${CLAIM_KEYS.join(", ")}`;
  if (typeof claims.jti !== "string" || !OPAQUE_ID.test(claims.jti))
    return "jti is not a valid id";
  if (typeof claims.agentId !== "string" || !AGENT_ID.test(claims.agentId))
    return "agentId is not a valid agent id";
  if (!nonEmpty(claims.tool, 256)) return "tool is required";
  if (!nonEmpty(claims.target, 512)) return "target is required";
  if (!isScope(claims.scope)) return "scope is not a known scope";
  if (!nonEmpty(claims.workspace, 256)) return "workspace is required";
  if (!Number.isSafeInteger(claims.iat) || (claims.iat as number) < 0)
    return "iat must be whole unix seconds";
  if (!Number.isSafeInteger(claims.exp)) return "exp must be whole unix seconds";
  if (typeof claims.agentPolicyDigest !== "string" || !DIGEST.test(claims.agentPolicyDigest))
    return "agentPolicyDigest must be a sha256 hex digest";
  return null;
}

/**
 * Checks the signature and the claim shape. A failure says why in words that
 * never contain the token. It does not check expiry or revocation.
 */
export async function verifyToken(
  value: unknown,
  verifier: TokenVerifier,
): Promise<VerifiedToken> {
  const invalid = (reason: string): VerifiedToken => ({
    ok: false,
    ruleId: BUILTIN_RULES.tokenInvalid,
    reason,
  });
  try {
    if (typeof value !== "string" || value === "")
      return invalid("token is not a string");
    if (value.length > MAX_TOKEN_LENGTH)
      return invalid(`token is longer than ${MAX_TOKEN_LENGTH}`);
    const parts = value.split(".");
    if (parts.length !== 2) return invalid("token is not payload.signature");
    const [payloadB64, signatureB64] = parts as [string, string];
    const payloadBytes = fromBase64url(payloadB64);
    const signature = fromBase64url(signatureB64);
    if (payloadBytes === null || signature === null)
      return invalid("token is not base64url");
    let payload: unknown;
    try {
      payload = JSON.parse(decoder.decode(payloadBytes));
    } catch {
      return invalid("token payload is not JSON");
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload))
      return invalid("token payload is not an object");
    const { v, alg, kid, claims } = payload as Record<string, unknown>;
    if (Object.keys(payload).length !== 4)
      return invalid("token payload has unknown fields");
    if (v !== TOKEN_FORMAT) return invalid(`token format is not ${TOKEN_FORMAT}`);
    if (alg !== verifier.alg)
      return invalid(`token algorithm is not ${verifier.alg}`);
    if (typeof kid !== "string" || !OPAQUE_ID.test(kid))
      return invalid("token key id is not valid");
    // Signature before the claims are trusted for anything.
    const spki = await verifier.publicKey(kid);
    if (spki === null) return invalid("token is signed by an unknown key");
    if (!verifySignature(verifier.alg, tokenSigningPreimage(payloadB64), signature, spki))
      return invalid("token signature does not verify");
    const problem = claimsProblem(claims);
    if (problem !== null) return invalid(`token claims: ${problem}`);
    return { ok: true, claims: claims as TokenClaims, keyId: kid };
  } catch {
    return invalid("token could not be verified");
  }
}

export type IssueDeps = Omit<CheckDeps, "requireToken"> & {
  readonly signer: KeyProvider;
  /** Injectable for tests; a UUID by default. */
  readonly newTokenId?: () => string;
};

export type IssueResult =
  | {
      readonly kind: "issued";
      readonly token: SignedToken;
      readonly check: PolicyCheckResult;
    }
  /**
   * No token. On hold the issuer would wait for a person; how an approved
   * hold becomes a token without a second hold at the proxy is open for
   * [DAVID], contract section 10.
   */
  | { readonly kind: "held"; readonly check: PolicyCheckResult }
  | { readonly kind: "denied"; readonly check: PolicyCheckResult };

/**
 * Steps 1 to 3: the issuance check, then a 60 second token on allow only.
 * A token request that carries a token is refused: issuance is never a
 * renewal.
 */
export async function issueToken(
  request: PolicyCheckRequest,
  deps: IssueDeps,
): Promise<IssueResult> {
  const { signer, newTokenId, ...checkDeps } = deps;
  if (request.token !== undefined) {
    const ruleId = BUILTIN_RULES.invalidRequest;
    return {
      kind: "denied",
      check: {
        contract: POLICY_CHECK_CONTRACT,
        requestId: typeof request.requestId === "string" ? request.requestId : "",
        decision: "deny",
        reason: "a token request must not carry a token; issuance is never a renewal",
        class: "unknown",
        ruleId,
        layer: "engine",
        trace: [{ layer: "engine", decision: "deny", ruleId }],
        agentPolicyDigest: null,
        classPolicyDigest: null,
      },
    };
  }
  const check = checkPolicy(request, { ...checkDeps, requireToken: false });
  if (check.decision === "hold") return { kind: "held", check };
  if (check.decision !== "allow" || check.agentPolicyDigest === null)
    return { kind: "denied", check };
  const iat = Math.floor(deps.now().getTime() / 1000);
  const claims: TokenClaims = {
    jti: (newTokenId ?? randomUUID)(),
    agentId: request.agent.id,
    tool: request.tool,
    target: request.target,
    scope: request.scope,
    workspace: request.workspace,
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
    agentPolicyDigest: check.agentPolicyDigest,
  };
  return { kind: "issued", token: await signToken(claims, signer), check };
}

export type CallCheckDeps = Omit<CheckDeps, "requireToken"> & {
  readonly verifier: TokenVerifier;
};

/**
 * Step 5, what the proxy calls: verify the bearer value, then run the engine
 * with the verified claims and a token required. A token that does not verify
 * is a deny on the token layer; the kill-switch still wins over it, because a
 * killed agent is the more useful thing for an operator to read.
 */
export async function checkCall(
  request: Omit<PolicyCheckRequest, "token">,
  tokenValue: unknown,
  deps: CallCheckDeps,
): Promise<PolicyCheckResult> {
  const { verifier, ...checkDeps } = deps;
  const verified = await verifyToken(tokenValue, verifier);
  const engine = { ...checkDeps, requireToken: true };
  if (verified.ok)
    return checkPolicy({ ...request, token: verified.claims }, engine);
  // Run the engine without a token: it denies with nomo:token-missing, or with
  // the kill-switch or an invalid request first. Only the missing-token deny is
  // renamed to say why the token was refused.
  const result = checkPolicy({ ...request }, engine);
  if (result.ruleId !== BUILTIN_RULES.tokenMissing) return result;
  const trace = result.trace.slice(0, -1);
  return {
    ...result,
    ruleId: verified.ruleId,
    reason: verified.reason,
    trace: [...trace, { layer: "token", decision: "deny", ruleId: verified.ruleId }],
  };
}

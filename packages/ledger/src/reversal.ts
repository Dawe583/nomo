/**
 * A record that inverts an earlier record on the same chain.
 *
 * The claim this shape exists to make is narrow and is the whole of it: a
 * process holding a key signed a statement that some earlier record in this
 * same chain, identified by its sequence and its entry hash, was inverted.
 * The signature says a key wrote those bytes and the chain says the bytes are
 * in order. Neither says the inverse did what it claimed in the system it
 * touched, and nothing here may be read as saying so: proving that needs a
 * post-write read in the target system, which is a receipt the connector
 * writes, not a property of this chain.
 *
 * Naming the target by sequence *and* digest is what makes the claim checkable
 * by someone holding only the file. A sequence alone would break silently the
 * moment the chain grew or a file was spliced, and would then name a different
 * record than the one the writer meant. The digest is the identity; the
 * sequence is the position, and the verifier requires both to agree with the
 * entry it already checked.
 *
 * The rule enforced here is that a named record must already exist earlier in
 * the chain being verified. A reversal that names a sequence the chain does not
 * hold, names itself, or names a record whose digest is not the one the chain
 * verified is a finding, because the alternative is a signed record asserting
 * an inversion of something that is not there.
 *
 * The journal chain in `packages/runtime` links its recovery events with
 * `reverses`, an operation id, because that chain is keyed by operation rather
 * than by position. This chain is positional, so the link is by sequence and
 * digest. They are the same idea over two different keys.
 */

const ENTRY_DIGEST = /^[0-9a-f]{64}$/;

const REVERSAL_KEYS: Readonly<Record<string, true>> = { seq: true, digest: true };

/** The record a reversal names, by position and by identity. */
export type LedgerReversal = {
  readonly seq: number;
  readonly digest: string;
};

/** A record inverts nothing, inverts one earlier record, or cannot be read. */
export type LedgerReversalRead =
  | { readonly kind: "none" }
  | { readonly kind: "reversal"; readonly reversal: LedgerReversal }
  | { readonly kind: "malformed"; readonly detail: string };

const NONE: LedgerReversalRead = Object.freeze({ kind: "none" });

/**
 * Builds the link. Shared by every writer that inverts something, so the two
 * fields are spelled the same way whoever writes them and a verifier has one
 * shape to read rather than one per surface.
 */
export function buildReversal(seq: number, digest: string): LedgerReversal {
  return { seq, digest };
}

/**
 * Reads the link off a stored body. A missing field inverts nothing and is not
 * a malformed body, for the same reason a missing attribution is not: almost
 * every record in the chain is a forward record, and refusing the ones that
 * name no inversion would refuse the ordinary case.
 */
export function readLedgerReversal(body: unknown, seq: number): LedgerReversalRead {
  if (typeof body !== "object" || body === null) return NONE;
  const raw = (body as Record<string, unknown>).reversal;
  if (raw === undefined) return NONE;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return malformed(seq, "reversal is not an object");
  const record = raw as Record<string, unknown>;

  const extra = Object.keys(record).filter(
    (key) => !Object.hasOwn(REVERSAL_KEYS, key),
  );
  if (extra.length > 0)
    return malformed(seq, `reversal carries unknown key ${extra.join(", ")}`);

  const named = record.seq;
  if (typeof named !== "number" || !Number.isSafeInteger(named) || named < 1)
    return malformed(seq, "reversal seq is not a whole number of at least one");

  const digest = record.digest;
  if (typeof digest !== "string" || !ENTRY_DIGEST.test(digest))
    return malformed(seq, "reversal digest is not 64 lowercase hex characters");

  return { kind: "reversal", reversal: { seq: named, digest } };
}

/**
 * The chain rule, applied by every verifier at the entry that carries the
 * reversal. `hashOf` resolves the entry hash the verifier already checked at a
 * sequence, so the comparison is against the chain and not against anything
 * the reversal record itself claims.
 *
 * One lookup decides both ways the claim can fail. A sequence the verified
 * prefix does not hold is a sequence that is not in this chain earlier than
 * the record making the claim, whether the chain never had it or the claim
 * points forward. Splitting those into two rules would leave one unreachable
 * from either verifier, because a gap and a forward reference are the same
 * fact seen from two sides.
 *
 * Returns the finding, or undefined when the named record is earlier in this
 * same chain and its digest is the one the chain holds.
 */
export function reversalFinding(
  reversal: LedgerReversal,
  atSeq: number,
  hashOf: (seq: number) => string | undefined,
): string | undefined {
  const found = hashOf(reversal.seq);
  if (found === undefined)
    return `reversal names seq ${reversal.seq}, which this chain does not hold earlier than the record carrying it at seq ${atSeq}`;
  if (found !== reversal.digest)
    return `reversal names seq ${reversal.seq} as ${reversal.digest.slice(0, 8)} but the chain holds ${found.slice(0, 8)}`;
  return undefined;
}

function malformed(seq: number, detail: string): LedgerReversalRead {
  return { kind: "malformed", detail: `entry ${seq} ${detail}` };
}

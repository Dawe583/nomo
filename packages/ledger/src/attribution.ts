/**
 * Why a decision record exists.
 *
 * The attribution lives inside the entry body, which is the whole reason it
 * fits the format without a migration: the entry hash is computed over the
 * body that was actually written, and the signature covers that hash. An entry
 * written before this field existed has no such field, and it keeps verifying,
 * because nothing about its bytes changed. Binding a new fact into an
 * append-only hash chain is an additive change to a value that is already
 * opaque; rewriting the shape of the chain would not be.
 *
 * What is new is the read side, and the read side is where this can go wrong.
 * Three absences are different facts about a record:
 *
 *   - the record makes no attribution claim at all (an entry from before the
 *     field existed, or from a writer that has no policy to name);
 *   - the record names the policy but no rule, because the decision named no
 *     rule;
 *   - a rule fired and carries no rationale, which is a rule that fired.
 *
 * A reader that collapses the third into the second reports "this call was
 * authorized by a rule that said nothing" for a record that in fact said
 * nothing about a rule. `readLedgerReason` keeps them apart and refuses, by
 * name, any attribution whose shape it cannot vouch for.
 */

const POLICY_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Shared, so verifying a hundred thousand entries does not allocate a hundred
 * thousand identical answers.
 */
const UNATTRIBUTED: LedgerReason = Object.freeze({ kind: "unattributed" });
const ATTRIBUTION_KEYS = new Set(["policyDigest", "rule"]);
const RULE_KEYS = new Set(["index", "rationale"]);

/** What a writer binds into the body of a decision record. */
export type LedgerAttribution = {
  /**
   * sha256 over the canonical JSON of the policy content the decision was
   * made under: `canonicalDigest(policyFile)`, in the form every other
   * content digest in this repository uses. A third party who obtains that
   * policy file recomputes this and knows the record was made under it,
   * rather than being told so by whoever wrote the record.
   */
  readonly policyDigest: string;
  /**
   * The rule that decided this call. Absent means the decision named no rule,
   * which is a fact about the decision rather than a missing value, and is
   * why it is not folded into an index of zero or a rationale of "".
   */
  readonly rule?: {
    readonly index: number;
    /** Absent means the rule carries no rationale. "" is a rationale. */
    readonly rationale?: string;
  };
};

/** The three states a record can be in, plus a named refusal. */
export type LedgerReason =
  | { readonly kind: "unattributed" }
  | { readonly kind: "attributed"; readonly attribution: LedgerAttribution }
  | { readonly kind: "malformed"; readonly detail: string };

/**
 * Builds the persisted attribution from a decision that may or may not have
 * named a rule. Shared by every writer so the record is shaped the same way
 * whoever wrote it; a rationale is carried through verbatim, including the
 * empty string, because an empty rationale is still a stated one.
 */
export function buildAttribution(
  policyDigest: string,
  decision: {
    readonly ruleIndex?: number;
    readonly rationale?: string;
  },
): LedgerAttribution {
  if (typeof decision.ruleIndex !== "number") return { policyDigest };
  return {
    policyDigest,
    rule: {
      index: decision.ruleIndex,
      ...(decision.rationale === undefined
        ? {}
        : { rationale: decision.rationale }),
    },
  };
}

/**
 * Reads the attribution off a stored body. A missing field is `unattributed`,
 * never `malformed`: that is what an entry written before the field existed
 * looks like, and there is no migration to run, so reading it must not fail.
 */
export function readLedgerReason(body: unknown, seq: number): LedgerReason {
  if (typeof body !== "object" || body === null) return UNATTRIBUTED;
  const raw = (body as Record<string, unknown>).attribution;
  if (raw === undefined) return UNATTRIBUTED;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return malformed(seq, "attribution is not an object");
  const record = raw as Record<string, unknown>;

  const extra = Object.keys(record).filter((key) => !ATTRIBUTION_KEYS.has(key));
  if (extra.length > 0)
    return malformed(seq, `attribution carries unknown key ${extra.join(", ")}`);

  const policyDigest = record.policyDigest;
  if (typeof policyDigest !== "string" || !POLICY_DIGEST.test(policyDigest))
    return malformed(
      seq,
      "attribution policyDigest is not 64 lowercase hex characters",
    );

  const rule = record.rule;
  if (rule === undefined) return { kind: "attributed", attribution: { policyDigest } };
  if (typeof rule !== "object" || rule === null || Array.isArray(rule))
    return malformed(seq, "attribution rule is not an object");
  const rawRule = rule as Record<string, unknown>;

  const ruleExtra = Object.keys(rawRule).filter((key) => !RULE_KEYS.has(key));
  if (ruleExtra.length > 0)
    return malformed(seq, `attribution rule carries unknown key ${ruleExtra.join(", ")}`);

  const index = rawRule.index;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
    return malformed(seq, "attribution rule index is not a whole number");

  const rationale = rawRule.rationale;
  if (rationale === undefined)
    return {
      kind: "attributed",
      attribution: { policyDigest, rule: { index } },
    };
  if (typeof rationale !== "string")
    return malformed(seq, "attribution rule rationale is not a string");
  return {
    kind: "attributed",
    attribution: { policyDigest, rule: { index, rationale } },
  };
}

function malformed(seq: number, detail: string): LedgerReason {
  return { kind: "malformed", detail: `entry ${seq} ${detail}` };
}

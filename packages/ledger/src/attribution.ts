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
 * Both digest spellings this repository already writes. The proxy writes bare
 * hex because `policyDigest` does, and the workbench writes `sha256:`-prefixed
 * digests for `argsDigest` and `captureDigest`, so a validator that demanded
 * one form would refuse a record the other surface wrote honestly.
 */
const CONTENT_DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/;

/**
 * A model id is a vendor token, not a free field: it lands in a signed body a
 * third party will render, so it is bounded and free of control characters.
 * The charset is deliberately permissive, because a stricter pattern would
 * turn a provider's naming choice into a failed chain.
 */
const MODEL_ID = /^[^\x00-\x1f\x7f]{1,200}$/;

/**
 * Shared, so verifying a hundred thousand entries does not allocate a hundred
 * thousand identical answers.
 */
const UNATTRIBUTED: LedgerReason = Object.freeze({ kind: "unattributed" });
const ATTRIBUTION_KEYS: Readonly<Record<string, true>> = {
  policyDigest: true,
  rule: true,
  modelId: true,
  requestDigest: true,
};
const RULE_KEYS: Readonly<Record<string, true>> = { index: true, rationale: true };

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
   * Which model was asked to make the call. Absent means the writer had no
   * model to name, which is a fact about how the record was made rather than a
   * missing value: a path that decides on a call it was handed must not borrow
   * the name of a model that never saw it.
   */
  readonly modelId?: string;
  /**
   * sha256 over the outbound request this decision authorised. Absent means no
   * outbound request was hashed, and a record naming a policy must not have a
   * request invented for it.
   */
  readonly requestDigest?: string;
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
  context: AttributionContext = {},
): LedgerAttribution {
  const named = { policyDigest, ...optional(context) };
  if (typeof decision.ruleIndex !== "number") return named;
  return {
    ...named,
    rule: {
      index: decision.ruleIndex,
      ...(decision.rationale === undefined
        ? {}
        : { rationale: decision.rationale }),
    },
  };
}

/**
 * The model and request facts, kept out of the required fields so that a
 * writer which knows neither does not have to spell two absences, and a
 * reader which finds them missing has exactly one absence to read.
 */
export type AttributionContext = {
  readonly modelId?: string;
  readonly requestDigest?: string;
};

function optional(context: AttributionContext): AttributionContext {
  return {
    ...(context.modelId === undefined ? {} : { modelId: context.modelId }),
    ...(context.requestDigest === undefined
      ? {}
      : { requestDigest: context.requestDigest }),
  };
}

/**
 * Reads the attribution off a stored body. A missing field is `unattributed`,
 * never `malformed`: that is what an entry written before the field existed
 * looks like, and there is no migration to run, so reading it must not fail.
 *
 * The compatibility rule the widening rests on, stated once here because it
 * governs every field added to this shape: a field that was added later is
 * optional, and its absence is a fact about when the record was written rather
 * than a defect in it. A record written before `modelId` existed has no
 * `modelId`; its bytes did not change when the field was added, its entry hash
 * is the hash of the body that was actually written, and it keeps verifying.
 * A verifier that read absence as failure would retroactively invalidate every
 * ledger written before each field existed, which is a migration this format
 * does not have and must not acquire. Presence is therefore the only thing
 * that can be wrong, and a present field this reader cannot vouch for is a
 * named finding at the entry.
 */
export function readLedgerReason(body: unknown, seq: number): LedgerReason {
  if (typeof body !== "object" || body === null) return UNATTRIBUTED;
  const raw = (body as Record<string, unknown>).attribution;
  if (raw === undefined) return UNATTRIBUTED;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return malformed(seq, "attribution is not an object");
  const record = raw as Record<string, unknown>;

  const extra = Object.keys(record).filter(
    (key) => !Object.hasOwn(ATTRIBUTION_KEYS, key),
  );
  if (extra.length > 0)
    return malformed(seq, `attribution carries unknown key ${extra.join(", ")}`);

  const policyDigest = record.policyDigest;
  if (typeof policyDigest !== "string" || !POLICY_DIGEST.test(policyDigest))
    return malformed(
      seq,
      "attribution policyDigest is not 64 lowercase hex characters",
    );

  const modelId = record.modelId;
  if (modelId !== undefined && (typeof modelId !== "string" || !MODEL_ID.test(modelId)))
    return malformed(
      seq,
      "attribution modelId is not a bounded string free of control characters",
    );

  const requestDigest = record.requestDigest;
  if (
    requestDigest !== undefined &&
    (typeof requestDigest !== "string" || !CONTENT_DIGEST.test(requestDigest))
  )
    return malformed(
      seq,
      "attribution requestDigest is not 64 lowercase hex characters",
    );

  const model = modelId === undefined ? {} : { modelId };
  const request =
    requestDigest === undefined ? {} : { requestDigest };
  const rule = record.rule;
  if (rule === undefined)
    return { kind: "attributed", attribution: { policyDigest, ...model, ...request } };
  if (typeof rule !== "object" || rule === null || Array.isArray(rule))
    return malformed(seq, "attribution rule is not an object");
  const rawRule = rule as Record<string, unknown>;

  const ruleExtra = Object.keys(rawRule).filter(
    (key) => !Object.hasOwn(RULE_KEYS, key),
  );
  if (ruleExtra.length > 0)
    return malformed(seq, `attribution rule carries unknown key ${ruleExtra.join(", ")}`);

  const index = rawRule.index;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0)
    return malformed(seq, "attribution rule index is not a whole number");

  const rationale = rawRule.rationale;
  if (rationale === undefined)
    return {
      kind: "attributed",
      attribution: { policyDigest, ...model, ...request, rule: { index } },
    };
  if (typeof rationale !== "string")
    return malformed(seq, "attribution rule rationale is not a string");
  return {
    kind: "attributed",
    attribution: { policyDigest, ...model, ...request, rule: { index, rationale } },
  };
}

function malformed(seq: number, detail: string): LedgerReason {
  return { kind: "malformed", detail: `entry ${seq} ${detail}` };
}

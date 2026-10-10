/**
 * Versioned machine-readable adapter capability profile (G-06 / WP-R00).
 *
 * A profile describes what one adapter version can recover, on which
 * boundary, with which explicit exclusions. It is descriptive, not authority:
 * `authority` is the literal `scope-only`, so a profile can never be read as
 * permission to execute a production request, and `certification` is `false`
 * unless a certified evidence block names the checks, the run and the exact
 * adapter version behind the claim.
 *
 * `void.adapter-capability.v2` replaces v1: v2 makes `authority`,
 * `maxDecodedBytes`, `conformance.runtime` and
 * `conformance.sharedRuntimeChecksOnly` required, makes `certification`
 * required instead of omittable, and refuses unknown fields instead of
 * ignoring them. A v1 report is rejected, never coerced, and an adapter that
 * does not fit the schema is refused rather than skipped.
 *
 * `certificationDecision` is where the dated answer lives. The field itself
 * says whether an adapter is certified now; the decision says whether it ever
 * will be and why, which is a question a boolean cannot answer. It is optional
 * on a profile, and the release gate refuses a published profile that omits
 * it, so the answer travels with the profile rather than only in a document.
 *
 * This module is pure: no imports, so `packages/registry`-style layering
 * stays intact and the CLI conformance runner can reuse it without cycles.
 */

export const CAPABILITY_SCHEMA = "void.adapter-capability.v2";
export const CONFORMANCE_SCHEMA = "void.adapter-conformance.v1";

/** G-06: the profile is a scope statement. It never authorizes execution. */
export type CapabilityAuthority = "scope-only";

export interface CapabilityConformanceRef {
  readonly schema: string;
  /**
   * Id of the runtime that executed the checks, e.g. "nomo-recovery-runtime".
   * The runtime owns the case list, so two profiles with the same runtime id
   * ran the same cases and two profiles with different ids did not.
   */
  readonly runtime: string;
  /** Disposable fixture the checks ran against, e.g. "disposable-local-file-create-write-delete". */
  readonly fixture: string;
  /** Named checks that passed, e.g. ["restart-idempotence", "human-drift"]. */
  readonly checks: readonly string[];
  /** True only when the case list above is the shared runtime's, uncertified. */
  readonly sharedRuntimeChecksOnly: boolean;
}

/** The only shape that may stand in for `false` and claim certification. */
export interface CapabilityCertifiedEvidence {
  readonly certified: true;
  readonly checks: readonly string[];
  /** ISO timestamp of the certifying run. */
  readonly at: string;
  /** Adapter version the run certified. Must equal adapter.version. */
  readonly adapterVersion: string;
}

export type CapabilityCertification = false | CapabilityCertifiedEvidence;

/**
 * The dated answer to the question `certification` cannot answer: whether this
 * adapter is ever going to claim certification, and why the field reads the
 * way it does. Optional in the schema, required of every published profile by
 * the release gate, because a decision nobody wrote down is not a decision.
 */
export interface CapabilityCertificationDecision {
  /** Calendar day the decision was taken, e.g. "2026-09-26". */
  readonly decidedOn: string;
  /** Why the decision was taken, in one sentence. */
  readonly reason: string;
}

export interface CapabilityProfile {
  readonly schema: string;
  readonly adapter: { readonly id: string; readonly version: string };
  readonly authority: CapabilityAuthority;
  readonly operations: readonly string[];
  /** Enforceable boundary, e.g. "cooperative-regular-file-paths". */
  readonly boundary: string;
  /** Largest payload the adapter reads or restores, in bytes. */
  readonly maxDecodedBytes: number;
  /** Platform to recovery guarantee, e.g. { posix: "bytes-and-mode" }. */
  readonly recovery: { readonly [platform: string]: string };
  readonly durableExecutionReceipt: boolean;
  readonly durableRecoveryReceipt: boolean;
  readonly excluded: readonly string[];
  readonly conformance: CapabilityConformanceRef;
  readonly certification: CapabilityCertification;
  /** Dated answer on whether this adapter will ever be certified. */
  readonly certificationDecision?: CapabilityCertificationDecision;
  /** Free-text scope note, e.g. why a scenario is not a public action. */
  readonly note?: string;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A YYYY-MM-DD that is a real day in the calendar. The format alone is not
 * enough: `Date.parse` reads "2026-02-30" as March 2 and "2026-13-45" as
 * nothing at all, so a typo has to be caught by reading the date back.
 */
const isCalendarDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !CALENDAR_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

/**
 * A machine-readable contract whose consumer is a program: an unrecognized
 * field means the profile and this schema disagree, and reading the known
 * fields anyway would report a scope nobody validated.
 */
const unknownFields = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): readonly string[] =>
  Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `unknown field ${JSON.stringify(key)}`);

/**
 * Returns validation errors; empty means the profile shape is sound.
 * Shape-sound is not certified: see `certificationStatus`.
 */
export function validateCapabilityProfile(profile: unknown): string[] {
  if (!isObject(profile)) return ["profile must be an object"];
  const p = profile;
  const errors: string[] = [
    ...unknownFields(p, [
      "schema",
      "adapter",
      "authority",
      "operations",
      "boundary",
      "maxDecodedBytes",
      "recovery",
      "durableExecutionReceipt",
      "durableRecoveryReceipt",
      "excluded",
      "conformance",
      "certification",
      "certificationDecision",
      "note",
    ]),
  ];
  if (p["schema"] !== CAPABILITY_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(CAPABILITY_SCHEMA)}`);
  }
  if (!isObject(p["adapter"])) {
    errors.push("adapter must be an object with id and version");
  } else {
    errors.push(...unknownFields(p["adapter"], ["id", "version"]));
    if (!isNonEmptyString(p["adapter"]["id"])) errors.push("adapter.id must be a non-empty string");
    if (!isNonEmptyString(p["adapter"]["version"])) errors.push("adapter.version must be a non-empty string");
  }
  if (p["authority"] !== "scope-only") {
    errors.push('authority must be "scope-only": a profile states scope, never authorization');
  }
  // An empty operation list is a platform exclusion, not an unfinished
  // profile: the adapter has to name a platform it refuses outright.
  const hasExcludedPlatform =
    isObject(p["recovery"]) &&
    Object.values(p["recovery"]).some((guarantee) => guarantee === "unsupported");
  if (!isStringArray(p["operations"])) {
    errors.push("operations must be a string array");
  } else if (p["operations"].length === 0 && !hasExcludedPlatform) {
    errors.push("operations may be empty only when recovery excludes a platform as unsupported");
  }
  if (!isNonEmptyString(p["boundary"])) {
    errors.push("boundary must be a non-empty string");
  }
  if (
    typeof p["maxDecodedBytes"] !== "number" ||
    !Number.isInteger(p["maxDecodedBytes"]) ||
    (p["maxDecodedBytes"] as number) <= 0
  ) {
    errors.push("maxDecodedBytes must be a positive integer");
  }
  if (!isObject(p["recovery"]) || Object.keys(p["recovery"]).length === 0) {
    errors.push("recovery must be a non-empty platform-to-guarantee map");
  } else {
    for (const [platform, guarantee] of Object.entries(p["recovery"])) {
      if (!isNonEmptyString(guarantee)) {
        errors.push(`recovery[${JSON.stringify(platform)}] must be a non-empty string`);
      }
    }
  }
  if (typeof p["durableExecutionReceipt"] !== "boolean") {
    errors.push("durableExecutionReceipt must be an explicit boolean");
  }
  if (typeof p["durableRecoveryReceipt"] !== "boolean") {
    errors.push("durableRecoveryReceipt must be an explicit boolean");
  }
  if (!isStringArray(p["excluded"])) {
    errors.push("excluded must be a string array");
  }
  if (p["note"] !== undefined && !isNonEmptyString(p["note"])) {
    errors.push("note must be a non-empty string when present");
  }
  errors.push(...validateCertificationDecision(p["certificationDecision"]));
  if (!isObject(p["conformance"])) {
    errors.push("conformance must be an object with schema, runtime, fixture and checks");
  } else {
    errors.push(
      ...unknownFields(p["conformance"], [
        "schema",
        "runtime",
        "fixture",
        "checks",
        "sharedRuntimeChecksOnly",
      ]),
    );
    if (p["conformance"]["schema"] !== CONFORMANCE_SCHEMA) {
      errors.push(`conformance.schema must be ${JSON.stringify(CONFORMANCE_SCHEMA)}`);
    }
    if (!isNonEmptyString(p["conformance"]["runtime"])) {
      errors.push("conformance.runtime must name the runtime that ran the checks");
    }
    if (!isNonEmptyString(p["conformance"]["fixture"])) {
      errors.push("conformance.fixture must be a non-empty string");
    }
    if (!isStringArray(p["conformance"]["checks"]) || p["conformance"]["checks"].length === 0) {
      errors.push("conformance.checks must be a non-empty string array");
    }
    if (typeof p["conformance"]["sharedRuntimeChecksOnly"] !== "boolean") {
      errors.push("conformance.sharedRuntimeChecksOnly must be an explicit boolean");
    }
  }
  errors.push(...validateCertification(p["certification"], p["adapter"]));
  return errors;
}

function validateCertification(
  certification: unknown,
  adapter: unknown,
): readonly string[] {
  if (certification === false) return [];
  if (!isObject(certification)) {
    return [
      "certification must be false, or an evidence object naming the certified checks; a bare true is not evidence",
    ];
  }
  const errors: string[] = [...unknownFields(certification, ["certified", "checks", "at", "adapterVersion"])];
  if (certification["certified"] !== true) {
    errors.push("certification.certified must be true inside an evidence object");
  }
  if (!isStringArray(certification["checks"]) || certification["checks"].length === 0) {
    errors.push("certified profile must name the checks behind the claim");
  }
  if (!isNonEmptyString(certification["at"]) || !ISO_TIMESTAMP.test(certification["at"] as string)) {
    errors.push("certified profile must carry an ISO run timestamp (at)");
  }
  const adapterVersion = isObject(adapter) ? adapter["version"] : undefined;
  if (!isNonEmptyString(certification["adapterVersion"])) {
    errors.push("certified profile must name the certified adapterVersion");
  } else if (certification["adapterVersion"] !== adapterVersion) {
    errors.push("certification.adapterVersion must equal adapter.version");
  }
  return errors;
}

/**
 * Optional on a profile, but a decision that cannot be read as a date is not a
 * record of anything, so a present block is checked as strictly as a
 * certification claim is.
 */
function validateCertificationDecision(decision: unknown): readonly string[] {
  if (decision === undefined) return [];
  if (!isObject(decision)) {
    return ["certificationDecision must be an object with decidedOn and reason"];
  }
  const errors: string[] = [...unknownFields(decision, ["decidedOn", "reason"])];
  if (!isCalendarDate(decision["decidedOn"])) {
    errors.push("certificationDecision.decidedOn must be a real calendar date (YYYY-MM-DD)");
  }
  if (!isNonEmptyString(decision["reason"])) {
    errors.push("certificationDecision.reason must name why the decision was taken");
  }
  return errors;
}

export interface CertificationStatus {
  readonly certified: boolean;
  /** True when only shared runtime checks apply: no certified claim. */
  readonly sharedRuntimeChecksOnly: boolean;
}

/**
 * Never default-true. Certified only with an evidence block that validates
 * against this profile, so a claimed run, a missing check list or a drifted
 * adapter version all land on the uncertified side.
 */
export function certificationStatus(profile: CapabilityProfile): CertificationStatus {
  const sound = validateCapabilityProfile(profile).length === 0;
  const certification = profile.certification;
  const certified =
    sound &&
    certification !== false &&
    certification.certified === true &&
    certification.checks.length > 0 &&
    certification.adapterVersion === profile.adapter.version;
  return { certified, sharedRuntimeChecksOnly: !certified };
}

/** True only when the profile was issued for exactly this adapter version. */
export function bindsAdapter(
  profile: CapabilityProfile,
  adapterId: string,
  adapterVersion: string,
): boolean {
  return profile.adapter.id === adapterId && profile.adapter.version === adapterVersion;
}

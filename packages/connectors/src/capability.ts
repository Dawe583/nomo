/**
 * Versioned machine-readable adapter capability profile (G-06 / WP-R00).
 *
 * A profile describes what one adapter version can recover, on which
 * boundary, with which explicit exclusions. It is descriptive, not authority:
 * a profile never authorizes production execution and `certified` is never
 * default-true. Without a `certification` block the adapter is uncertified
 * and consumers must treat it as shared-runtime-checks-only.
 *
 * This module is pure: no imports, so `packages/registry`-style layering
 * stays intact and the CLI conformance runner can reuse it without cycles.
 */

export const CAPABILITY_SCHEMA = "void.adapter-capability.v1";
export const CONFORMANCE_SCHEMA = "void.adapter-conformance.v1";

export interface CapabilityConformanceRef {
  readonly schema: string;
  /** Disposable fixture the checks ran against, e.g. "disposable-local-file-create-write-delete". */
  readonly fixture: string;
  /** Named checks that passed, e.g. ["restart-idempotence", "human-drift"]. */
  readonly checks: readonly string[];
}

export interface CapabilityCertification {
  readonly certified: boolean;
  /** Non-empty when certified: the exact checks behind the claim. */
  readonly checks: readonly string[];
  /** ISO timestamp of the certifying run. Required when certified. */
  readonly at?: string;
  /** Adapter version the run certified. Must equal adapter.version. */
  readonly adapterVersion?: string;
}

export interface CapabilityProfile {
  readonly schema: string;
  readonly adapter: { readonly id: string; readonly version: string };
  readonly operations: readonly string[];
  /** Enforceable boundary, e.g. "cooperative-regular-file-paths". */
  readonly boundary: string;
  /** Platform to recovery guarantee, e.g. { posix: "bytes-and-mode" }. */
  readonly recovery: { readonly [platform: string]: string };
  readonly durableExecutionReceipt: boolean;
  readonly durableRecoveryReceipt: boolean;
  readonly excluded: readonly string[];
  readonly conformance: CapabilityConformanceRef;
  readonly certification?: CapabilityCertification;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/**
 * Returns validation errors; empty means the profile shape is sound.
 * Shape-sound is not certified: see `certificationStatus`.
 */
export function validateCapabilityProfile(profile: unknown): string[] {
  const errors: string[] = [];
  if (typeof profile !== "object" || profile === null) {
    return ["profile must be an object"];
  }
  const p = profile as Record<string, unknown>;
  if (p["schema"] !== CAPABILITY_SCHEMA) {
    errors.push(`schema must be ${JSON.stringify(CAPABILITY_SCHEMA)}`);
  }
  const adapter = p["adapter"] as Record<string, unknown> | undefined;
  if (typeof adapter !== "object" || adapter === null) {
    errors.push("adapter must be an object with id and version");
  } else {
    if (!isNonEmptyString(adapter["id"])) errors.push("adapter.id must be a non-empty string");
    if (!isNonEmptyString(adapter["version"])) errors.push("adapter.version must be a non-empty string");
  }
  if (!isStringArray(p["operations"]) || (p["operations"] as readonly string[]).length === 0) {
    errors.push("operations must be a non-empty string array");
  }
  if (!isNonEmptyString(p["boundary"])) {
    errors.push("boundary must be a non-empty string");
  }
  const recovery = p["recovery"] as Record<string, unknown> | undefined;
  if (typeof recovery !== "object" || recovery === null || Object.keys(recovery).length === 0) {
    errors.push("recovery must be a non-empty platform-to-guarantee map");
  } else {
    for (const [platform, guarantee] of Object.entries(recovery)) {
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
  const conformance = p["conformance"] as Record<string, unknown> | undefined;
  if (typeof conformance !== "object" || conformance === null) {
    errors.push("conformance must be an object with schema, fixture and checks");
  } else {
    if (conformance["schema"] !== CONFORMANCE_SCHEMA) {
      errors.push(`conformance.schema must be ${JSON.stringify(CONFORMANCE_SCHEMA)}`);
    }
    if (!isNonEmptyString(conformance["fixture"])) {
      errors.push("conformance.fixture must be a non-empty string");
    }
    if (!isStringArray(conformance["checks"]) || (conformance["checks"] as readonly string[]).length === 0) {
      errors.push("conformance.checks must be a non-empty string array");
    }
  }
  const certification = p["certification"] as Record<string, unknown> | undefined;
  if (certification !== undefined) {
    if (typeof certification["certified"] !== "boolean") {
      errors.push("certification.certified must be a boolean");
    } else if (certification["certified"] === true) {
      if (!isStringArray(certification["checks"]) || (certification["checks"] as readonly string[]).length === 0) {
        errors.push("certified profile must name the checks behind the claim");
      }
      if (!isNonEmptyString(certification["at"])) {
        errors.push("certified profile must carry the run timestamp (at)");
      }
      const adapterVersion = (p["adapter"] as Record<string, unknown> | undefined)?.["version"];
      if (
        certification["adapterVersion"] !== undefined &&
        certification["adapterVersion"] !== adapterVersion
      ) {
        errors.push("certification.adapterVersion must equal adapter.version");
      }
    }
  }
  return errors;
}

export interface CertificationStatus {
  readonly certified: boolean;
  /** True when only shared runtime checks apply: no certified claim. */
  readonly sharedRuntimeChecksOnly: boolean;
}

/**
 * Never default-true. Certified only with a `certification` block whose
 * `certified` is true, checks are non-empty and the profile shape is sound.
 */
export function certificationStatus(profile: CapabilityProfile): CertificationStatus {
  const sound = validateCapabilityProfile(profile).length === 0;
  const cert = profile.certification;
  const certified =
    sound &&
    cert !== undefined &&
    cert.certified === true &&
    cert.checks.length > 0 &&
    (cert.adapterVersion === undefined || cert.adapterVersion === profile.adapter.version);
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

/**
 * Per-provider capability profile set (G-06 / WP-R00).
 *
 * One global `certification`/`sharedRuntimeChecksOnly` flag is only honest
 * while every provider really runs on one runtime. It does: the case list
 * lives in `runAdapterConformance`, so `filesystem.managed`, `git.managed` and
 * `managed-documents` are checked by the same eight cases in the same process.
 * This module states that as a binding rather than as a constant, so a future
 * provider with its own runtime shows up as a different `conformance.runtime`
 * instead of silently inheriting a shared-runtime claim.
 *
 * The set is fail-closed: an unknown adapter, a profile that does not fit the
 * schema, a duplicate id, a profile bound to another runtime or a declared
 * `sharedRuntimeChecksOnly` that disagrees with the derived certification
 * status all throw instead of being skipped.
 */

import {
  bindsAdapter,
  certificationStatus,
  validateCapabilityProfile,
  type CapabilityProfile,
} from "./capability.ts";

/** The runtime that owns the conformance case list every provider runs. */
export const CONFORMANCE_RUNTIME = {
  id: "void-recovery-runtime",
  surface: "runAdapterConformance",
  /** The case list belongs to the runtime, so it is shared by construction. */
  shared: true,
} as const;

export class CapabilityProfileError extends Error {
  readonly errors: readonly string[];

  constructor(message: string, errors: readonly string[] = []) {
    super(errors.length > 0 ? `${message}: ${errors.join("; ")}` : message);
    this.name = "CapabilityProfileError";
    this.errors = errors;
  }
}

export interface ProviderProfileSet {
  /** Adapter ids this set publishes, in declaration order. */
  readonly ids: readonly string[];
  readonly entries: readonly CapabilityProfile[];
}

/**
 * Validates every profile against the versioned schema and cross-checks the
 * claims a profile makes about itself. Anything that does not fit throws here,
 * at declaration time, rather than at the point where a run would use it.
 */
export function declareProviderProfiles(
  entries: readonly unknown[],
  runtime: { readonly id: string } = CONFORMANCE_RUNTIME,
): ProviderProfileSet {
  if (entries.length === 0) {
    throw new CapabilityProfileError("a provider profile set must declare at least one adapter");
  }
  const seen = new Map<string, CapabilityProfile>();
  const profiles: CapabilityProfile[] = [];
  for (const entry of entries) {
    const errors = validateCapabilityProfile(entry);
    if (errors.length > 0) {
      const id = (entry as { adapter?: { id?: unknown } } | null)?.adapter?.id;
      throw new CapabilityProfileError(
        `capability profile for ${typeof id === "string" ? id : "an unnamed adapter"} does not fit ${"void.adapter-capability.v2"}`,
        errors,
      );
    }
    const profile = entry as CapabilityProfile;
    const previous = seen.get(profile.adapter.id);
    if (previous !== undefined) {
      throw new CapabilityProfileError(
        `duplicate capability profile for ${JSON.stringify(profile.adapter.id)}: versions ${previous.adapter.version} and ${profile.adapter.version}`,
      );
    }
    if (profile.conformance.runtime !== runtime.id) {
      throw new CapabilityProfileError(
        `capability profile for ${JSON.stringify(profile.adapter.id)} binds runtime ${JSON.stringify(profile.conformance.runtime)}, the set declares ${JSON.stringify(runtime.id)}`,
      );
    }
    const status = certificationStatus(profile);
    if (profile.conformance.sharedRuntimeChecksOnly !== status.sharedRuntimeChecksOnly) {
      throw new CapabilityProfileError(
        `capability profile for ${JSON.stringify(profile.adapter.id)} declares sharedRuntimeChecksOnly ${profile.conformance.sharedRuntimeChecksOnly} but its certification status says ${status.sharedRuntimeChecksOnly}`,
      );
    }
    seen.set(profile.adapter.id, profile);
    profiles.push(profile);
  }
  return Object.freeze({
    ids: Object.freeze(profiles.map((profile) => profile.adapter.id)),
    entries: Object.freeze(profiles),
  });
}

/** True when the set publishes a profile for this adapter id. */
export function hasProviderProfile(set: ProviderProfileSet, adapterId: string): boolean {
  return set.entries.some((profile) => profile.adapter.id === adapterId);
}

/**
 * The only way a caller gets a profile. An adapter id the set does not
 * publish is refused with the ids that do exist: there is no fallback and no
 * "run it and see" path.
 */
export function resolveProviderProfile(
  set: ProviderProfileSet,
  adapterId: string,
): CapabilityProfile {
  // `bindsAdapter` is the one place the "was this profile issued for exactly
  // this adapter" rule lives, so resolution goes through it instead of
  // repeating the comparison. The version is the profile's own here; the
  // conformance runner is what later binds it to a runtime adapter.
  const profile = set.entries.find((entry) => bindsAdapter(entry, adapterId, entry.adapter.version));
  if (profile === undefined) {
    throw new CapabilityProfileError(
      `no capability profile for adapter ${JSON.stringify(adapterId)}; published: ${set.ids.join(", ")}`,
    );
  }
  return profile;
}

/**
 * The runtime id every published profile ran on. `declareProviderProfiles`
 * already refuses a set whose profiles disagree, so the first entry speaks
 * for all of them; the release gate asserts the value against
 * CONFORMANCE_RUNTIME and names the provider that diverges.
 */
export function sharedConformanceRuntime(set: ProviderProfileSet): string {
  return set.entries[0]!.conformance.runtime;
}

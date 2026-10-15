/**
 * A policy profile is the name of a policy file on disk, not a policy
 * embedded in the profile.
 *
 * The names come from the same directory `NOMO_POLICY_PATH` points at, so the
 * operator's own policy files are the catalogue and this runtime grows no second
 * place to configure one. `default` is the built-in operator policy and needs
 * no file, which is why a workbench with no policy path configured is never
 * left without one.
 *
 * Resolution never falls back. A name with no file, a file that is not valid
 * YAML, a file the policy validator rejects, and a name that is not a bare
 * policy name are all the same answer: unresolved, and unresolved denies.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadPolicy, type ValidPolicy } from "../../policy/src/rules.ts";

/** The built-in operator policy, used when a profile names `default`. */
export const DEFAULT_POLICY =
  "version: 1\nrules:\n  - match:\n      class: r0\n    decision: allow\n  - match: {}\n    decision: hold\n    seconds: 300\n    notify: [cli]\n";

export const DEFAULT_POLICY_PROFILE = "default";

/** A bare policy name: no separator, no traversal, nothing to escape the
 * policy directory with. The file it names is `<name>.yaml`. */
const POLICY_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

export type ResolvedPolicyProfile =
  | {
      readonly ok: true;
      readonly name: string;
      /** Where the policy came from, or `builtin` for `default`. */
      readonly path: string;
      readonly policy: ValidPolicy;
    }
  | { readonly ok: false; readonly name: string; readonly reason: string };


/**
 * The policy names an agent profile may use: `default` plus every `.yaml`
 * file beside the operator's policy path. A directory that cannot be read
 * leaves the catalogue at `default` rather than throwing, because listing is a
 * read and an unreadable directory must not take the catalogue down with it.
 * `default.yaml` is not listed: the name is the built-in policy, so offering
 * the file as a second way to reach it would be a choice that does nothing.
 */
export function listPolicyProfiles(policyPath: string | undefined): string[] {
  const directory = policyPath ? dirname(policyPath) : undefined;
  if (!directory) return [DEFAULT_POLICY_PROFILE];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [DEFAULT_POLICY_PROFILE];
  }
  const names = entries
    .filter((entry) => entry.endsWith(".yaml") && !entry.startsWith("."))
    .map((entry) => entry.slice(0, -".yaml".length))
    .filter((name) => POLICY_NAME.test(name) && name !== DEFAULT_POLICY_PROFILE)
    .sort();
  return [DEFAULT_POLICY_PROFILE, ...names];
}

/**
 * Resolve a policy profile name to the policy it selects. Every failure is a
 * refusal with a reason the operator can act on, and no branch returns a
 * policy it did not just read and validate.
 */
export function resolvePolicyProfile(
  name: string,
  policyPath: string | undefined,
): ResolvedPolicyProfile {
  if (!POLICY_NAME.test(name))
    return {
      ok: false,
      name,
      reason: "a policy profile is a bare name, not a path",
    };
  if (name === DEFAULT_POLICY_PROFILE) {
    const loaded = loadPolicy(DEFAULT_POLICY);
    if (loaded.ok) return { ok: true, name, path: "builtin", policy: loaded };
    return { ok: false, name, reason: "the built-in policy is not valid" };
  }
  const directory = policyPath ? dirname(policyPath) : undefined;
  if (!directory)
    return {
      ok: false,
      name,
      reason: `no policy directory is configured; set NOMO_POLICY_PATH or select ${DEFAULT_POLICY_PROFILE}`,
    };
  const path = join(directory, `${name}.yaml`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, name, reason: `no readable policy file at ${path}` };
  }
  const loaded = loadPolicy(text);
  if (!loaded.ok)
    return {
      ok: false,
      name,
      reason: `${path} is not a valid policy: ${loaded.errors.join("; ")}`,
    };
  return { ok: true, name, path, policy: loaded };
}
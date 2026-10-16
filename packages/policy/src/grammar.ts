/**
 * The policy grammar: the keys a match may name, the decisions a rule may
 * return, and the version the file declares.
 *
 * These live here, in a leaf module, rather than in `index.ts`, because
 * `index.ts` is a barrel that also re-exports the pack loader and the approval
 * broker. Both of those touch the filesystem, so a leaf that imported them for
 * two string constants would drag `node:fs`, `node:path` and `node:url` into
 * every consumer's dependency graph, including the agent-step workflow, whose
 * runtime refuses Node builtins outright. The barrel is the public surface; the
 * grammar is what the modules inside it share.
 */

export const POLICY_VERSION = 1;

/** The whole grammar. Five keys, and every one of them is used. */
export const MATCH_KEYS = [
  "class",
  "tool",
  "connector",
  "workspace",
  "blast_radius",
] as const;

export type MatchKey = (typeof MATCH_KEYS)[number];

export type Decision = "allow" | "deny" | "hold";

/**
 * No rule in a valid file matched. Hold is the only decision that is itself
 * reversible, and the notification tells the operator which rule they are
 * missing, so the default teaches the policy file rather than blocking work or
 * silently permitting it. The schema still requires a terminal catch-all rule,
 * so in a well formed file this never fires.
 */
export const UNMATCHED_DECISION: Decision = "hold";

/**
 * The file is missing, unreadable, invalid, or of an unknown version. That is a
 * broken configuration rather than an unmatched call, and the two must not
 * resolve the same way.
 */
export const BROKEN_POLICY_DECISION: Decision = "deny";

/** An unclassified call is treated as R3, which makes registry coverage a safety property. */
export const UNCLASSIFIED_CLASS = "r3";

/**
 * The explicit opt-in class an allow rule lists to authorize an unclassified
 * call. Without it, an allow rule never matches an unclassified call, so a
 * broad allow cannot silently authorize what the registry could not classify.
 */
export const UNKNOWN_CLASS = "unknown";

export function isMatchKey(name: string): name is MatchKey {
  return (MATCH_KEYS as readonly string[]).includes(name);
}

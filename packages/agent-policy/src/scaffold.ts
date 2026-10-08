/**
 * The default `policy/agents.yaml` a new workspace starts with: one declared
 * agent and a single rule that denies. The agent is known, so the kill-switch
 * and the CLI can name it, and it can do nothing until someone writes a grant.
 *
 * Writing never replaces a file that is already there. A file identical to the
 * default is reported as unchanged; any other file is the operator's and is
 * kept as it is, even when it does not load, because an init that "repaired"
 * a policy would silently widen or narrow what agents may do. The caller is
 * told what it found and decides what to say.
 */

import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AGENT_ID } from "./grammar.ts";
import { loadAgentPolicy } from "./load.ts";

export const DEFAULT_AGENT_ID = "local-agent";

export class AgentPolicyScaffoldError extends Error {}

export type DefaultAgentPolicyOptions = {
  /** The one agent the file declares. Defaults to {@link DEFAULT_AGENT_ID}. */
  readonly agentId?: string;
  /** Who answers for the agent; free text, shown in the dashboard. */
  readonly owner?: string;
};

const OWNER_MAX = 120;

function optionsProblem(options: DefaultAgentPolicyOptions): string | null {
  const agentId = options.agentId ?? DEFAULT_AGENT_ID;
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId))
    return "agent id must match ^[a-z0-9][a-z0-9._-]{0,63}$";
  const owner = options.owner;
  if (owner === undefined) return null;
  if (
    typeof owner !== "string" ||
    owner.trim() === "" ||
    owner.length > OWNER_MAX ||
    /[\x00-\x1f\x7f]/.test(owner)
  )
    return `owner must be a non-empty line of at most ${OWNER_MAX} characters`;
  return null;
}

/**
 * The default file as text. Values are written as JSON strings, which YAML
 * reads as strings: an id such as 123, null or true is a valid agent id and
 * would otherwise load as a number, null or a boolean.
 */
export function defaultAgentPolicy(
  options: DefaultAgentPolicyOptions = {},
): string {
  const problem = optionsProblem(options);
  if (problem !== null) throw new AgentPolicyScaffoldError(problem);
  const agentId = options.agentId ?? DEFAULT_AGENT_ID;
  const owner =
    options.owner === undefined
      ? ""
      : `    owner: ${JSON.stringify(options.owner)}\n`;
  return `# NOMO agent policy: which agent may act, on what, with which scope.
# Evaluated together with the VOID class policy; the stricter answer wins.
# First match wins, and the last rule must be match: {} with decision: deny.
#
# This default declares one agent and grants it nothing. Add a rule above
# default-deny to let it act, for example:
#
#   - id: ${agentId}-reads-notes
#     match:
#       agent: ${JSON.stringify(agentId)}
#       target_prefix: fs:sandbox/notes/
#       scope: read
#       class: unknown
#     decision: allow
#     rationale: the agent may read the shared notes folder
version: 1
agents:
  - id: ${JSON.stringify(agentId)}
${owner}rules:
  - id: default-deny
    match: {}
    decision: deny
    rationale: no rule grants this agent this action
`;
}

export type ScaffoldResult =
  | { readonly status: "created"; readonly path: string }
  /** The file is byte for byte the default, line endings aside. */
  | { readonly status: "unchanged"; readonly path: string }
  /**
   * The file differs from the default and was left alone. `problems` lists
   * load errors when the kept file does not load, so the caller can say so.
   */
  | {
      readonly status: "kept";
      readonly path: string;
      readonly problems: readonly string[];
    };

const sameText = (a: string, b: string) =>
  a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/**
 * Writes the default file at `path` unless something is there already. The
 * create is exclusive, so two inits racing on one path cannot both write, and
 * the loser reports what the winner wrote.
 */
export async function writeDefaultAgentPolicy(
  path: string,
  options: DefaultAgentPolicyOptions = {},
): Promise<ScaffoldResult> {
  const text = defaultAgentPolicy(options);
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(path, "wx", 0o644);
    try {
      await handle.writeFile(text, "utf8");
    } finally {
      await handle.close();
    }
    return { status: "created", path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  let existing: string;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    throw new AgentPolicyScaffoldError(
      `${path} exists and cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}); nothing was written`,
    );
  }
  if (sameText(existing, text)) return { status: "unchanged", path };
  const loaded = loadAgentPolicy(existing);
  return { status: "kept", path, problems: loaded.ok ? [] : loaded.errors };
}

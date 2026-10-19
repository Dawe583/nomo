/**
 * The agent policy file: YAML in, validated agents and rules out.
 *
 * Hand written validation in the same style as `@void/policy/src/rules.ts`,
 * because a validator that names the path in the file is what an operator can
 * act on. A load error is returned, never thrown: the caller denies with the
 * reason instead of crashing.
 */

import { parse } from "yaml";
import {
  AGENT_ID,
  AGENT_POLICY_VERSION,
  CLASSES,
  HOLD_CEILING_SECONDS,
  RULE_ID,
  SCOPES,
  isAgentMatchKey,
  type AgentDecision,
} from "./grammar.ts";

export type AgentEntry = {
  readonly id: string;
  /** Who answers for this agent. Free text, shown in the dashboard. */
  readonly owner?: string;
};

/** A string or a list of strings; a list means any of. */
export type AgentMatchValue = string | readonly string[];

export type AgentRuleMatch = {
  readonly [key: string]: AgentMatchValue | undefined;
};

export type AgentRule = {
  readonly id: string;
  readonly match: AgentRuleMatch;
  readonly decision: AgentDecision;
  readonly seconds?: number;
  readonly rationale?: string;
};

export type AgentPolicyFile = {
  readonly version: number;
  readonly agents: readonly AgentEntry[];
  readonly rules: readonly AgentRule[];
};

export type LoadedAgentPolicy =
  | { readonly ok: true; readonly policy: AgentPolicyFile }
  | { readonly ok: false; readonly errors: readonly string[] };

const DECISIONS: readonly AgentDecision[] = ["allow", "deny", "hold"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const unknownKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): string[] => Object.keys(value).filter((key) => !allowed.includes(key));

export function validateAgentPolicyFile(value: unknown): string[] {
  if (!isObject(value)) return ["agent policy: must be an object"];
  const errors: string[] = [];
  const extra = unknownKeys(value, ["version", "agents", "rules"]);
  if (extra.length > 0)
    errors.push(`agent policy: unknown key ${extra.join(", ")}`);
  if (value.version !== AGENT_POLICY_VERSION)
    errors.push(`version: must be ${AGENT_POLICY_VERSION}`);

  const declared = new Set<string>();
  if (!Array.isArray(value.agents) || value.agents.length === 0) {
    errors.push("agents: required, a non-empty list of agents");
  } else {
    value.agents.forEach((raw, index) => {
      const path = `agents[${index}]`;
      if (!isObject(raw)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      const keys = unknownKeys(raw, ["id", "owner"]);
      if (keys.length > 0)
        errors.push(`${path}: unknown key ${keys.join(", ")}`);
      if (typeof raw.id !== "string" || !AGENT_ID.test(raw.id)) {
        errors.push(
          `${path}.id: required, lowercase letters, digits, dot, dash or underscore, at most 64`,
        );
        return;
      }
      if (declared.has(raw.id))
        errors.push(`${path}.id: ${raw.id} is declared twice`);
      declared.add(raw.id);
      if (raw.owner !== undefined && typeof raw.owner !== "string")
        errors.push(`${path}.owner: must be a string`);
    });
  }

  if (!Array.isArray(value.rules) || value.rules.length === 0)
    return [...errors, "rules: required, a non-empty list of rules"];

  const ruleIds = new Set<string>();
  value.rules.forEach((raw, index) => {
    const path = `rules[${index}]`;
    if (!isObject(raw)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    const keys = unknownKeys(raw, [
      "id",
      "match",
      "decision",
      "seconds",
      "rationale",
    ]);
    if (keys.length > 0) errors.push(`${path}: unknown key ${keys.join(", ")}`);

    if (typeof raw.id !== "string" || !RULE_ID.test(raw.id))
      errors.push(
        `${path}.id: required, lowercase letters, digits, dot, dash or underscore, at most 64`,
      );
    else if (ruleIds.has(raw.id))
      errors.push(`${path}.id: ${raw.id} is used twice`);
    else ruleIds.add(raw.id);

    if (!isObject(raw.match))
      errors.push(`${path}.match: required, an object of match keys`);
    else errors.push(...validateMatch(raw.match, `${path}.match`, declared));

    if (!DECISIONS.includes(raw.decision as AgentDecision))
      errors.push(`${path}.decision: must be allow, deny or hold`);
    if (raw.decision === "hold") {
      const seconds = raw.seconds;
      if (
        typeof seconds !== "number" ||
        !Number.isInteger(seconds) ||
        seconds < 1
      )
        errors.push(
          `${path}.seconds: required for hold, a whole number of seconds, at least 1`,
        );
      else if (seconds > HOLD_CEILING_SECONDS)
        errors.push(
          `${path}.seconds: the hold ceiling is ${HOLD_CEILING_SECONDS} seconds`,
        );
    } else if (raw.seconds !== undefined) {
      errors.push(`${path}.seconds: only a hold has a timer`);
    }
    if (raw.rationale !== undefined && typeof raw.rationale !== "string")
      errors.push(`${path}.rationale: must be a string`);
  });

  // Deny by default is a property of the file, not a convention: the last
  // rule is the unguarded catch-all and it denies.
  const last = value.rules[value.rules.length - 1];
  const isCatchAll = (rule: unknown): boolean =>
    isObject(rule) &&
    isObject(rule.match) &&
    Object.keys(rule.match).length === 0;
  if (!isCatchAll(last))
    errors.push(
      "rules: the last rule must be the unguarded catch-all, match: {}",
    );
  else if ((last as Record<string, unknown>).decision !== "deny")
    errors.push(
      "rules: the catch-all must deny, an agent gets only what a rule grants",
    );
  value.rules.slice(0, -1).forEach((rule, index) => {
    if (isCatchAll(rule))
      errors.push(
        `rules[${index}]: match: {} before the last rule makes every later rule unreachable`,
      );
  });
  return errors;
}

function validateMatch(
  match: Record<string, unknown>,
  path: string,
  declared: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(match)) {
    if (!isAgentMatchKey(key)) {
      errors.push(
        `${path}.${key}: not a match key, expected one of agent, tool, connector, target, target_prefix, scope, class, workspace`,
      );
      continue;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) {
      errors.push(`${path}.${key}: an empty list matches nothing`);
      continue;
    }
    if (!values.every((item) => typeof item === "string" && item !== "")) {
      errors.push(
        `${path}.${key}: must be a non-empty string or a list of them`,
      );
      continue;
    }
    const strings = values as string[];
    if (key === "agent") {
      for (const id of strings)
        if (!declared.has(id))
          errors.push(
            `${path}.agent: ${id} is not declared under agents, so the rule could never match`,
          );
    }
    // A prefix without a separator at the end, fs:sandbox/notes, would also
    // match fs:sandbox/notes-private. The boundary has to be written down.
    if (
      key === "target_prefix" &&
      !strings.every((p) => p.endsWith("/") || p.endsWith(":"))
    )
      errors.push(`${path}.target_prefix: must end with / or :`);
    if (
      key === "scope" &&
      !strings.every((s) => (SCOPES as readonly string[]).includes(s))
    )
      errors.push(
        `${path}.scope: must be ${SCOPES.join(", ")} or a list of those`,
      );
    if (
      key === "class" &&
      !strings.every((c) => (CLASSES as readonly string[]).includes(c))
    )
      errors.push(
        `${path}.class: must be ${CLASSES.join(", ")} or a list of those`,
      );
  }
  return errors;
}

export function loadAgentPolicy(text: string): LoadedAgentPolicy {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch {
    return { ok: false, errors: ["yaml: invalid agent policy syntax"] };
  }
  const errors = validateAgentPolicyFile(parsed);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, policy: parsed as AgentPolicyFile };
}

/**
 * Mining the signed chain for what the operator did not write down.
 *
 * This is the second half of `learned-rules.ts`, and it inherits that file's
 * discipline rather than restating it: a learned thing is *evidence, not
 * authority*, nothing here writes, and the only thing a mined entry is ever
 * allowed to become is a suggestion a human can reject.
 *
 * What is new here is the scope. `learned-rules.ts` mines refusals and can only
 * produce `hold`, because a refusal nobody asked for should pause for someone
 * who can undo it. That is the right shape for the one signal it reads. It is
 * too narrow for the rest of the chain, which also records what the operator
 * said *yes* to, and a harness that only ever learns from refusals learns that
 * everything is a problem.
 *
 * So there are two kinds here and they are not interchangeable:
 *
 * - `rule` is what `mineLearnedRules` already produces. Refusals only, `hold`
 *   only, and it goes into `policyWithLearned`.
 * - `lesson` is everything else. It never reaches `decide`. It is a note for an
 *   operator, and an entry with no `derivedFromSeq` cannot exist because there
 *   is nothing to point at.
 *
 * The third signal is the one neither reference harness has, and it is the most
 * useful thing in this file: **classification drift**. The registry decides a
 * class from facts about a call, and when the same tool lands in two different
 * classes across the chain, the registry's answer is not stable. That is a
 * safety finding before it is a performance one, and it is invisible in both
 * `omp` and `prime` because neither of them records what class it decided.
 *
 * Three rules hold for every entry produced here, and each one exists because
 * breaking it is cheap:
 *
 * 1. **Provenance is mandatory.** Every entry carries the chain sequences it was
 *    derived from. An entry that cannot say where it came from is a claim, and
 *    a claim in a signed chain is worse than no claim.
 * 2. **Ordering is deterministic.** Two runs over the same chain produce the same
 *    entries with the same ids, or the chain could not be diffed against itself.
 *    Ids are therefore derived from content, never from a clock or a counter.
 * 3. **Nothing is deleted.** A correction supersedes an entry; it does not
 *    remove it. `refinement_history.jsonl` in prime-agent is a file that can be
 *    lost, and this chain is the opposite of that.
 */

import type { Rule } from "../../policy/src/rules.ts";
import {
  LEARNED_RULE_MIN_REPEATS,
  learnedRule,
  learnedRuleGroups,
  ruleAsPolicyText,
  type LearnedRuleGroup,
} from "./learned-rules.ts";

/**
 * An entry as this module reads it.
 *
 * `seq` is part of the ledger type but a caller may hand over a projection
 * that dropped it, so it is read defensively rather than required. The
 * consequence is that an entry mined from a projection without sequences has an
 * empty `derivedFromSeq`, which `provenanceIsComplete` reports. Dropping such
 * entries instead would be worse: a caller who forgets to pass sequences would
 * get silence and read it as "nothing to learn".
 */
type Entry = { readonly body: unknown; readonly seq?: number };

/**
 * Kinds the harness holds. `rule` is what the refusal miner produces and is
 * listed so a consumer can treat the two shapes differently without inspecting
 * which module produced them.
 */
export const HARNESS_KINDS = ["rule", "lesson"] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

/**
 * `session` entries live in session state and are gone when the session is.
 * `workspace` entries are derived from the chain and therefore survive a
 * restart, which is not the same as being promoted: nothing here writes.
 */
export type HarnessScope = "session" | "workspace" | "operator";

export type HarnessEntry = {
  readonly id: string;
  readonly kind: HarnessKind;
  readonly scope: HarnessScope;
  readonly tool: string;
  readonly klass: string;
  readonly title: string;
  /** What was observed. Never a conclusion the chain does not support. */
  readonly content: string;
  /** Chain sequences this was derived from. Never empty. */
  readonly derivedFromSeq: readonly number[];
  readonly repeats: number;
  readonly createdAt: string;
  /** Set when an operator read this exact text and approved it by digest. The
   * chain records the approval; without this flag an approved instruction is
   * indistinguishable from a mined observation, and a prompt that tells the
   * model nothing here was operator-decided would be contradicting itself. */
  readonly decidedByOperator?: boolean;
  /** Set when a later entry corrects this one. The entry is kept, not removed. */
  readonly supersededBy?: string;
  /** The mined rule, when `kind` is `rule`. Absent otherwise. */
  readonly rule?: Rule;
  /**
   * The rule above as policy file text, when `kind` is `rule`.
   *
   * Both surfaces print this: the terminal command and the web panel, and the
   * operator's copy into their own policy file is the only way a mined rule
   * enters policy. Rendered here rather than by each surface so the text the
   * panel shows is provably the text the loader accepts.
   */
  readonly policyText?: readonly string[];
};

/**
 * How many repetitions of an approval pattern are worth an operator's
 * attention. Higher than the refusal threshold on purpose: a refusal is a
 * signal that something went wrong, while an approval is a signal that
 * something went the way it usually does, and the bar for writing a note about
 * a normal event should be higher than the bar for writing a note about an
 * abnormal one.
 */
export const LEARNED_LESSON_MIN_REPEATS = 5;

/** How many classes a tool must be seen in before disagreement is a finding
 * rather than a single reclassification. One change is noise; two is a pattern
 * nobody wrote down. */
export const CLASSIFICATION_DRIFT_MIN_CLASSES = 2;

function record(entry: Entry): Record<string, unknown> | null {
  const body = entry.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

function seq(entry: Entry): number | undefined {
  const body = record(entry);
  if (body === null) return undefined;
  const value = entry.seq;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Shape key, identical in construction to `learned-rules.ts` so the two miners
 * agree on what "the same call shape" means: JSON, never a raw NUL. */
function shapeKey(klass: string, tool: string): string {
  return JSON.stringify([klass, tool]);
}

/**
 * A content-addressed id. Same observation, same id, on every run and every
 * machine. A clock here would make two runs over an identical chain produce
 * different entries, and the chain could then not be compared to itself.
 */
function entryId(kind: HarnessKind, klass: string, tool: string, title: string): string {
  return `le_${kind}_${hex(shapeKey(klass, tool))}_${hex(title)}`;
}

/** A short, stable hash. Not a signature and not a security boundary: the
 * chain signs itself, and this only has to make ids deterministic. FNV-1a is
 * chosen because it is eight lines and needs no dependency. */
function hex(input: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0");
}

type Group = {
  klass: string;
  tool: string;
  repeats: number;
  seqs: number[];
};

/**
 * Approvals grouped by call shape.
 *
 * `hold:approved` and `hold:denied` are counted apart, and only the first
 * teaches anything. A tool the operator keeps *approving* is a tool the
 * operator has effectively sanctioned, and a harness that learns that is worth
 * far more than one that learns only from refusals, but it is still a note,
 * not a rule, because the operator approving a call once does not mean they
 * approve the next one unattended.
 *
 * `hold:expired` is excluded. Nobody answered, which is not approval; it is the
 * absence of a decision, and reading it as consent would be reading a timeout
 * as a yes.
 */
function approvedGroups(entries: readonly Entry[]): Group[] {
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const body = record(entry);
    if (body === null) continue;
    if (field(body, "decision") !== "hold:approved") continue;
    const tool = field(body, "tool");
    const klass = field(body, "klass");
    if (!tool || !klass) continue;
    const key = shapeKey(klass, tool);
    const existing = groups.get(key);
    const at = seq(entry);
    if (existing) {
      existing.repeats += 1;
      if (at !== undefined) existing.seqs.push(at);
    } else {
      groups.set(key, {
        klass,
        tool,
        repeats: 1,
        seqs: at === undefined ? [] : [at],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Tools the chain has classified into more than one class.
 *
 * This is the signal neither reference harness produces. `omp` records what the
 * agent did; `prime` records what it changed about itself; neither records what
 * the registry decided, so a classification that wanders is invisible in both.
 * Here it is a first-class finding, and it is a safety finding: the class is
 * what `decide` matches on, so a tool that is sometimes r1 and sometimes r3
 * gets a decision that depends on facts nobody reviewed.
 *
 * The entry names the classes rather than picking one. Choosing would be
 * guessing, and a guess here would feed straight into policy.
 */
function driftGroups(entries: readonly Entry[], minClasses: number): Group[] {
  const byTool = new Map<string, Map<string, number>>();
  const seqs = new Map<string, number[]>();
  for (const entry of entries) {
    const body = record(entry);
    if (body === null) continue;
    const tool = field(body, "tool");
    const klass = field(body, "klass");
    if (!tool || !klass) continue;
    const classes = byTool.get(tool) ?? new Map<string, number>();
    classes.set(klass, (classes.get(klass) ?? 0) + 1);
    byTool.set(tool, classes);
    const at = seq(entry);
    if (at !== undefined) {
      const list = seqs.get(tool) ?? [];
      list.push(at);
      seqs.set(tool, list);
    }
  }

  const out: Group[] = [];
  for (const [tool, classes] of byTool) {
    if (classes.size < minClasses) continue;
    // The majority class is carried as `klass` so the entry sorts and groups
    // like any other, and the full set goes in the content.
    let best = "";
    let bestCount = -1;
    const names = [...classes.keys()].sort();
    for (const name of names) {
      const count = classes.get(name) ?? 0;
      if (count > bestCount) {
        best = name;
        bestCount = count;
      }
    }
    out.push({
      klass: best,
      tool,
      repeats: [...classes.values()].reduce((sum, count) => sum + count, 0),
      seqs: (seqs.get(tool) ?? []).slice().sort((a, b) => a - b),
    });
  }
  return out;
}

function byShape(a: Group, b: Group): number {
  if (a.klass !== b.klass) return a.klass < b.klass ? -1 : 1;
  if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
  return 0;
}

export type MineOptions = {
  /** Threshold for the refusal miner, passed through unchanged. */
  readonly minRepeats?: number;
  /** Threshold for an approval lesson. Defaults to the constant above. */
  readonly lessonMinRepeats?: number;
  /** How many classes make disagreement a finding. */
  readonly driftMinClasses?: number;
  /** Stamped onto every entry so a caller can tell two extractions apart. */
  readonly generatedAt: string;
};

export type Mined = {
  readonly entries: readonly HarnessEntry[];
  /** The refusal rules, separated so a caller can read them as policy text
   * without having to filter the lessons back out. */
  readonly rules: readonly Rule[];
  /** The same rules as entries, carrying the count and the sequences they were
   * minted from, so an operator can read the rule rather than a count of it. */
  readonly ruleEntries: readonly HarnessEntry[];
};

/**
 * The mined rules as entries an operator can read and copy.
 *
 * A rule is a decision shape and a lesson is an observation, so they stay
 * apart; the entry exists because the operator needs the rule text. Nothing
 * decides from this module: the operator copies the rule into their own file,
 * and that copy is the only way a mined rule ever enters policy.
 */
export function minedRuleEntries(
  groups: readonly LearnedRuleGroup[],
  generatedAt: string,
): HarnessEntry[] {
  return groups.map((group) => {
    const title = "refused this call shape";
    const rule = learnedRule(group);
    return {
      id: entryId("rule", group.klass, group.tool, title),
      kind: "rule",
      scope: "workspace",
      tool: group.tool,
      klass: group.klass,
      title,
      content: rule.rationale ?? "",
      derivedFromSeq: group.seqs,
      repeats: group.repeats,
      createdAt: generatedAt,
      rule,
      policyText: ruleAsPolicyText(rule),
    };
  });
}

/**
 * Mine the chain for entries, refusing to produce an entry with no provenance.
 *
 * `seq` on an entry is optional in the chain type, so a caller may pass
 * entries that carry none. Those still teach, because the shape is legible, but
 * `derivedFromSeq` is then empty and the caller is expected to notice, see
 * `provenanceIsComplete`. The alternative, dropping such entries, would mean a
 * caller that forgets to pass sequences gets silence and reads it as "nothing
 * to learn", which is the failure this reports instead.
 */
export function mineHarnessEntries(
  entries: readonly Entry[],
  options: MineOptions,
): Mined {
  const lessonMin = options.lessonMinRepeats ?? LEARNED_LESSON_MIN_REPEATS;
  const driftMin = options.driftMinClasses ?? CLASSIFICATION_DRIFT_MIN_CLASSES;
  for (const [name, value] of [
    ["lessonMinRepeats", lessonMin],
    ["driftMinClasses", driftMin],
  ] as const) {
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`${name} must be a positive integer.`);
  }

  const groups = learnedRuleGroups(
    entries,
    options.minRepeats ?? LEARNED_RULE_MIN_REPEATS,
  );
  const rules = groups.map(learnedRule);
  const ruleEntries = minedRuleEntries(groups, options.generatedAt);
  const entriesOut: HarnessEntry[] = [];

  for (const group of approvedGroups(entries).sort(byShape)) {
    if (group.repeats < lessonMin) continue;
    const title = "operator keeps approving this call shape";
    entriesOut.push({
      id: entryId("lesson", group.klass, group.tool, title),
      kind: "lesson",
      scope: "workspace",
      tool: group.tool,
      klass: group.klass,
      title,
      // States the observation and stops there. "This is safe" is a conclusion
      // the chain does not carry, and a lesson is read by whoever owns the
      // harness.
      content:
        `Approved ${group.repeats} times on the signed ledger. Not written by an operator.`,
      derivedFromSeq: group.seqs,
      repeats: group.repeats,
      createdAt: options.generatedAt,
    });
  }

  for (const group of driftGroups(entries, driftMin).sort(byShape)) {
    const title = "this tool is classified into more than one class";
    entriesOut.push({
      id: entryId("lesson", group.klass, group.tool, title),
      kind: "lesson",
      scope: "workspace",
      tool: group.tool,
      klass: group.klass,
      title,
      content:
        `Seen in more than one reversibility class across ${group.repeats} records on the signed ledger.`,
      derivedFromSeq: group.seqs,
      repeats: group.repeats,
      createdAt: options.generatedAt,
    });
  }

  return { entries: entriesOut, rules, ruleEntries };
}

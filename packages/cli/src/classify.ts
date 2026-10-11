/**
 * The classify command, WP-04a: what the registry decides, over a transcript
 or for one call.
 *
 * It exists so a registry reviewer can see, without running a proxy, what
 * the current entries decide for a realistic session. An unclassified share
 * above the threshold is the number that tells the next migration batch
 * where coverage is thin, which is why it is printed first, not buried.
 *
 * The single call form answers the narrower question: what does this one
 * entry decide for this one tool, given these facts and these arguments. It
 * calls the same `evaluate` the transcript path and the proxy call, so a
 * tone it prints is a tone the intercepted call would get.
 */

import {
  registry,
  findEntry,
  evaluate,
  REGISTRY_DISCLAIMER,
  type RegistryTone,
} from "@void/registry";

export type TranscriptCall = {
  readonly tool: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly facts?: Readonly<Record<string, string | boolean | undefined>>;
};

export type ClassifyOutcome =
  | { readonly outcome: "classified"; readonly tone: RegistryTone }
  | { readonly outcome: "unknown-tool" }
  | {
      readonly outcome: "unclassified";
      readonly assume: RegistryTone | null;
      /**
       * The facts whose absence stopped a case deciding, so a caller can
       * name what would have. Empty when no case failed that way.
       */
      readonly missing: readonly string[];
    };

export type ClassifyReport = {
  readonly total: number;
  readonly distribution: Readonly<Record<RegistryTone | "unknown-tool" | "unclassified", number>>;
  readonly unclassifiedShare: number;
};

export function classifyCall(call: TranscriptCall): ClassifyOutcome {
  const entry = findEntry(call.tool);
  if (entry === undefined) return { outcome: "unknown-tool" };
  const result = evaluate(entry, {
    facts: call.facts ?? {},
    args: call.arguments ?? {},
  });
  if (result.outcome === "classified") return { outcome: "classified", tone: result.tone };
  if (result.outcome === "unclassified")
    return { outcome: "unclassified", assume: result.assumeTone, missing: result.missingFacts };
  // The entry was found above, so the evaluator cannot call it unknown;
  // the branch exists so the union narrows without a cast.
  return { outcome: "unknown-tool" };
}

/**
 * Declared facts come from the operator's configuration file and apply to the
 * whole transcript; a per-call fact of the same name wins, because the
 * interceptor's view at call time is fresher than the config.
 */
export function classifyTranscript(
  calls: readonly TranscriptCall[],
  declaredFacts: Readonly<Record<string, string | boolean>> = {},
): ClassifyReport {
  const distribution: Record<RegistryTone | "unknown-tool" | "unclassified", number> = {
    r0: 0,
    r1: 0,
    r2: 0,
    r3: 0,
    "unknown-tool": 0,
    unclassified: 0,
  };
  for (const call of calls) {
    const outcome = classifyCall({
      ...call,
      facts: { ...declaredFacts, ...call.facts },
    });
    if (outcome.outcome === "classified") distribution[outcome.tone] += 1;
    else distribution[outcome.outcome] += 1;
  }
  const total = calls.length;
  // The share is one decimal and rounds half up, so 1/6 reads 16.7 rather
  // than 16.66666, and the threshold check uses the rounded value the
  // operator reads, never a hidden more precise one.
  const unclassifiedShare =
    total === 0 ? 0 : Math.round((distribution.unclassified / total) * 1000) / 10;
  return { total, distribution, unclassifiedShare };
}

export function formatClassifyReport(report: ClassifyReport): string {
  const lines: string[] = [];
  lines.push(`calls: ${report.total}`);
  for (const key of ["r0", "r1", "r2", "r3", "unknown-tool", "unclassified"] as const) {
    lines.push(`${key}: ${report.distribution[key]}`);
  }
  lines.push(`unclassified: ${report.unclassifiedShare}%`);
  // Standards rule 10: the disclaimer travels verbatim with the data.
  lines.push("", REGISTRY_DISCLAIMER);
  return lines.join("\n");
}

/**
 * Parses one JSON object per line. A blank line is skipped; anything else
 * is a load error naming the line number, because a half written file must
 * not quietly drop calls from the denominator.
 */
export function parseTranscript(text: string): TranscriptCall[] {
  const calls: TranscriptCall[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`transcript line ${index + 1} is not JSON`);
    }
    if (typeof parsed !== "object" || parsed === null)
      throw new Error(`transcript line ${index + 1} is not an object`);
    const record = parsed as Record<string, unknown>;
    if (typeof record.tool !== "string" || record.tool === "")
      throw new Error(`transcript line ${index + 1} has no tool name`);
    calls.push(record as unknown as TranscriptCall);
  }
  return calls;
}

// The registry must load at all for any of this to be meaningful, and the
// reference is also the cheapest guard against an empty data file sneaking
// through an otherwise green suite.
export const REGISTRY_SIZE = registry.length;

const USAGE =
  "usage: nomo classify --transcript <file> [--facts <file>] | " +
  "nomo classify --tool <id> [--facts <file>] [--fact k=v] [--args <json>]";

/**
 * One JSON object, or a load error naming what was wrong with it. Both the
 * facts file and `--args` are the same shape, so they share one reader: a
 * second parser would be a second place for the two spellings to drift.
 */
export function parseJsonRecord(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${label} must be an object`);
  return parsed as Record<string, unknown>;
}

/**
 * The single call verdict. The disclaimer travels with it for the same
 * reason it travels with the distribution: a bare `tone: r3` on a terminal
 * is the one line an operator pastes into a ticket, and it reads as a
 * measured answer unless the label and the caveat come with it.
 *
 * `facts` says whether the tone came from declared facts at all. With none
 * supplied the evaluator can only reach an entry's terminal fallback, so a
 * `tone: r3` printed there is the fail-closed posture rather than a reading
 * of the operator's account, and the two must not look the same.
 */
export function formatSingleOutcome(
  tool: string,
  outcome: ClassifyOutcome,
  suppliedFacts: number,
): string {
  const lines = [`tool: ${tool}`, `outcome: ${outcome.outcome}`];
  if (outcome.outcome === "classified") lines.push(`tone: ${outcome.tone}`);
  else if (outcome.outcome === "unknown-tool")
    lines.push("tone: deny, unknown tool fails closed");
  else if (outcome.assume !== null) lines.push(`assume: ${outcome.assume}`);
  else lines.push("tone: deny, unclassified fails closed");
  if (outcome.outcome === "unclassified" && outcome.missing.length > 0)
    lines.push(`missing facts: ${outcome.missing.join(", ")}`);
  lines.push(
    suppliedFacts > 0
      ? `facts: ${suppliedFacts} declared`
      : "facts: none declared, so the tone above is the fail-closed fallback",
  );
  // Standards rule 10: the disclaimer travels verbatim with the data.
  lines.push("", REGISTRY_DISCLAIMER);
  return lines.join("\n");
}

/** One mode of the command, as the flags named one. */
type ClassifyFlags = {
  readonly transcript?: string;
  readonly tool?: string;
  readonly factsPath?: string;
  readonly argsJson?: string;
  readonly inlineFacts: readonly (readonly [string, string | boolean])[];
};

/**
 * Walks argv once. An unrecognised flag is a usage error rather than
 * something skipped: a `--fcts` typo that reads as "no facts were
 * declared" turns a measured verdict into the fail-closed one without ever
 * saying so.
 */
function parseClassifyFlags(argv: readonly string[]): ClassifyFlags {
  let transcript: string | undefined;
  let tool: string | undefined;
  let factsPath: string | undefined;
  let argsJson: string | undefined;
  const inlineFacts: (readonly [string, string | boolean])[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    // A flag value never starts with `--`, so the next token is read only
    // when it is a value and not the next flag the operator mistyped.
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next === "" || next.startsWith("--"))
        throw new Error(`${flag} needs a value. ${USAGE}`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--transcript":
        transcript = value();
        break;
      case "--tool":
        tool = value();
        break;
      case "--facts":
        factsPath = value();
        break;
      case "--args":
        argsJson = value();
        break;
      case "--fact": {
        const pair = value();
        const eq = pair.indexOf("=");
        if (eq <= 0) throw new Error("--fact needs k=v. " + USAGE);
        // The value stays the text the operator typed. Every `is` in the
        // registry and every fact a connector emits is a string, and `holds`
        // compares with ===, so turning "true" into a boolean here would
        // make the declared fact match no case at all and the call would
        // report the fallback while appearing to have been measured.
        inlineFacts.push([pair.slice(0, eq), pair.slice(eq + 1)]);
        break;
      }
      default:
        throw new Error(`unknown classify flag ${flag}. ${USAGE}`);
    }
  }
  return { transcript, tool, factsPath, argsJson, inlineFacts };
}

/**
 * The command line entry. With `--tool` it classifies that one call and
 * prints the verdict; with `--transcript` it prints the distribution over
 * every call in the file. Both go through `classifyCall`, so both reach the
 * one evaluator the proxy reaches.
 *
 * Exit codes: 0 for the transcript report and for a classified call, 2 for
 * a call the registry could not decide (an unknown tool, or an undecided
 * entry), 1 for a load error. A report the operator can act on is success
 * even when the share is high, because the share is the finding; a single
 * call with no verdict is not a finding, it is a gap.
 */
export async function runClassifyCommand(
  argv: readonly string[],
  readFile: (path: string) => string,
  stdout: (line: string) => void,
): Promise<number> {
  if (argv.indexOf("--tool") !== -1) {
    const flags = parseClassifyFlags(argv);
    const tool = flags.tool;
    if (tool === undefined) throw new Error(USAGE);
    let declared: Record<string, string | boolean> = {};
    if (flags.factsPath !== undefined) {
      // The facts file is the plain values map, the same shape loadFacts
      // returns, so the operator's verified file and the CLI agree.
      declared = parseJsonRecord(readFile(flags.factsPath), "facts file") as Record<
        string,
        string | boolean
      >;
    }
    // An inline pair is the operator's answer for this call, so it wins over
    // the file the way a per-call fact wins over the declared set.
    const facts = { ...declared };
    for (const [name, value] of flags.inlineFacts) facts[name] = value;
    const args =
      flags.argsJson === undefined ? {} : parseJsonRecord(flags.argsJson, "--args");
    const outcome = classifyCall({ tool, arguments: args, facts });
    stdout(formatSingleOutcome(tool, outcome, Object.keys(facts).length));
    return outcome.outcome === "classified" ? 0 : 2;
  }

  const flags = parseClassifyFlags(argv);
  if (flags.transcript === undefined) throw new Error(USAGE);

  const calls = parseTranscript(readFile(flags.transcript));
  let declaredFacts: Record<string, string | boolean> = {};
  if (flags.factsPath !== undefined) {
    declaredFacts = parseJsonRecord(readFile(flags.factsPath), "facts file") as Record<
      string,
      string | boolean
    >;
  }
  const report = classifyTranscript(calls, declaredFacts);
  stdout(formatClassifyReport(report));
  return 0;
}

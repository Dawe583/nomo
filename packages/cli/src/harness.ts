/**
 * The harness proposals, from a terminal.
 *
 * The harness proposes and the operator decides, and the digest a decision
 * binds to is the only handle on a proposal: it is the hash of the exact
 * text the operator was shown. The interactive shell could show that digest
 * and decide it, and a script had no way in at all, so the loop could not be
 * driven from a terminal without the interactive surface.
 *
 * The command reads the same workbench the interactive shell uses, so the
 * proposals it lists are the proposals the shell would show: both read the
 * signed chain of the workspace, and neither holds a proposal in process
 * memory.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../workbench/src/index.ts";
import { dataDir } from "../../ledger/src/paths.ts";

/** The parts of a mined rule this command prints. Structural, because the
 * command is a reader and does not need the policy package's whole type. */
export type RuleShape = {
  readonly match?: {
    readonly class?: string | readonly string[];
    readonly tool?: string | readonly string[];
    readonly connector?: string | readonly string[];
    readonly workspace?: string | readonly string[];
  };
  readonly decision: string;
  readonly seconds?: number;
  readonly notify?: readonly string[];
  readonly rationale?: string;
};

function policyScalar(value: string | readonly string[]): string {
  return Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
}

/**
 * A mined rule as policy file text.
 *
 * The rule is not in force, so the point of printing it is that the operator
 * can paste it into their own file. That only works if the loader accepts the
 * text, so the shape follows the grammar the loader enforces rather than a
 * pretty rendering of the object.
 */
export function ruleAsPolicyText(rule: RuleShape): string[] {
  const lines = ["- match:"];
  const match = rule.match ?? {};
  if (match.class !== undefined) lines.push(`    class: ${policyScalar(match.class)}`);
  if (match.tool !== undefined) lines.push(`    tool: ${policyScalar(match.tool)}`);
  if (match.connector !== undefined)
    lines.push(`    connector: ${policyScalar(match.connector)}`);
  if (match.workspace !== undefined)
    lines.push(`    workspace: ${policyScalar(match.workspace)}`);
  lines.push(`  decision: ${rule.decision}`);
  if (rule.decision === "hold" && typeof rule.seconds === "number")
    lines.push(`  seconds: ${rule.seconds}`);
  if (rule.notify?.length) lines.push(`  notify: [${rule.notify.join(", ")}]`);
  if (rule.rationale !== undefined)
    lines.push(`  rationale: ${JSON.stringify(rule.rationale)}`);
  return lines;
}

export type HarnessIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

/** The part of the workbench this command uses. Narrow on purpose: the
 * command is a reader and a decider, and it does not need the run path. */
export type HarnessSurface = {
  /** A live session, when the surface owns sessions. */
  get?(id: string): { readonly workspace: string } | undefined;
  /** The signed chain of a workspace, verified. Optional: a test double may
   * omit it, and the ratchet reports that there is nothing to measure. */
  ledger?(
    workspace: string,
  ): Promise<
    | {
        readonly entries: readonly { readonly body: unknown; readonly seq: number }[];
        readonly result: unknown;
        readonly verification: unknown;
      }
    | undefined
  >;
  /** The entries the harness currently holds for a session's workspace. */
  harnessEntries(
    sessionId: string,
  ): Promise<
    readonly {
      readonly id: string;
      readonly kind: string;
      readonly title: string;
      readonly content: string;
      readonly tool: string;
      readonly klass: string;
      readonly repeats: number;
      readonly decidedByOperator?: boolean;
      /** The mined rule, when the entry is one. Printed as policy text below
       * so an operator can copy it into their own file. */
      readonly rule?: RuleShape;
    }[]
  >;
  /** The reviewer model selection, as resolved. */
  harnessTextSettings(): { readonly refinementModel: string };
  patchHarnessTextSettings(
    body: Record<string, unknown>,
  ): { readonly refinementModel: string };
  pendingApprovalsFor(
    sessionId: string,
  ): Promise<
    readonly {
      readonly digest: string;
      readonly at: string;
      readonly summary: string;
      readonly proposal: {
        readonly edits: readonly {
          readonly action: string;
          readonly kind: string;
          readonly title?: string;
          readonly content?: string;
          readonly promptAddendum?: string;
          readonly derivedFromSeq: readonly number[];
        }[];
      };
    }[]
  >;
  approveHarnessProposal(
    sessionId: string,
    digest: string,
  ): Promise<{ readonly applied: readonly unknown[] }>;
  rejectHarnessProposal(
    sessionId: string,
    digest: string,
    reason?: string,
  ): Promise<void>;
  rollbackHarnessProposal(
    sessionId: string,
    digest: string,
  ): Promise<{ readonly applied: readonly unknown[] }>;
};

export type HarnessDeps = {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /** Injected so a test does not open the operator's real workspace. */
  readonly workbench?: () => Promise<HarnessSurface>;
};

/** Where the workbench keeps its state, resolved the way the workbench
 * resolves it. */
function workspaceDir(env: Readonly<NodeJS.ProcessEnv>): string {
  return (
    env.NOMO_DATA_DIR ??
    join(env.NOMO_LEDGER_DIR ?? dataDir(homedir()), "workbench")
  );
}

const USAGE = [
  "usage:",
  "  nomo harness list --session <id>",
  "  nomo harness approve --session <id> <digest>",
  "  nomo harness reject --session <id> <digest> --reason <text>",
  "  nomo harness rollback --session <id> <digest>",
  "  nomo harness entries --session <id> show what the harness holds",
  "  nomo harness ratchet --session <id> measure the guardrails before and after the last refinement",
  "  nomo harness model                 show the reviewer model",
  "  nomo harness model <model-id>      set the reviewer model",
  "  nomo harness model --clear         use the conversation's own model",
].join("\n");

type Flags = {
  readonly session: string;
  readonly reason: string;
  readonly digest: string;
  readonly clear: boolean;
  readonly unknown: readonly string[];
};

function parseFlags(args: readonly string[]): Flags {
  let session = "";
  let reason = "";
  let digest = "";
  let clear = false;
  const unknown: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--clear") {
      clear = true;
      continue;
    }
    if (arg === "--session") {
      session = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--reason") {
      reason = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      unknown.push(arg);
      continue;
    }
    digest = arg;
  }
  return { session, reason, digest, clear, unknown };
}

/** One line per edit, so a proposal can be read in a terminal. */
function describeEdit(edit: {
  readonly action: string;
  readonly kind: string;
  readonly title?: string;
  readonly content?: string;
  readonly promptAddendum?: string;
  readonly derivedFromSeq: readonly number[];
}): string {
  const text =
    edit.kind === "prompt"
      ? (edit.promptAddendum ?? "")
      : (edit.content ?? "");
  const body = text.length > 160 ? `${text.slice(0, 160)}...` : text;
  return `    ${edit.action} ${edit.kind}: ${edit.title ?? ""}${
    body ? ` | ${body}` : ""
  } | records ${edit.derivedFromSeq.join(", ")}`;
}

/**
 * The full digest behind what the operator typed.
 *
 * The interactive shell shows the first eight characters of a digest, so an
 * operator who read it there cannot paste it into a terminal. A prefix is
 * accepted when it names exactly one pending proposal, and refused when it
 * names none or several, because a decision that lands on the wrong
 * proposal is worse than one that does not land at all.
 */
async function resolveDigest(
  workbench: HarnessSurface,
  sessionId: string,
  typed: string,
): Promise<string> {
  if (typed.length === 64) return typed;
  const proposals = await workbench.pendingApprovalsFor(sessionId);
  const matches = proposals.filter((proposal) =>
    proposal.digest.startsWith(typed),
  );
  if (matches.length === 1) return matches[0]!.digest;
  if (matches.length > 1)
    throw new Error(
      `The digest prefix ${typed} names ${matches.length} pending proposals. Use more of it.`,
    );
  throw new Error(
    `No pending proposal matches the digest prefix ${typed}.`,
  );
}

export async function runHarnessCommand(
  args: readonly string[],
  io: HarnessIo,
  deps: HarnessDeps = {},
): Promise<number> {
  const action = args[0] ?? "";
  if (!action || action === "--help" || action === "-h") {
    io.stdout(USAGE);
    return action ? 0 : 1;
  }
  if (!["list", "entries", "approve", "reject", "rollback", "model", "ratchet"].includes(action)) {
    io.stderr(`Unknown harness action ${action}.`);
    io.stderr(USAGE);
    return 1;
  }
  const flags = parseFlags(args.slice(1));
  if (flags.unknown.length) {
    io.stderr(`Unknown option ${flags.unknown[0]}.`);
    io.stderr(USAGE);
    return 1;
  }
  if (action === "model") {
    const env = deps.env ?? process.env;
    if (!deps.workbench) {
      const directory = workspaceDir(env);
      if (!existsSync(directory)) {
        io.stderr(`No workspace at ${directory}. Run nomo init first.`);
        return 1;
      }
    }
    const workbench = deps.workbench
      ? await deps.workbench()
      : new Workbench(env);
    try {
      if (flags.clear) {
        const applied = workbench.patchHarnessTextSettings({ refinementModel: "" });
        io.stdout(
          `The reviewer runs on the conversation's own model now (${applied.refinementModel || "unset"}).`,
        );
        return 0;
      }
      if (!flags.digest) {
        const current = workbench.harnessTextSettings();
        io.stdout(
          current.refinementModel
            ? `The reviewer runs on ${current.refinementModel}.`
            : "The reviewer runs on the conversation's own model.",
        );
        return 0;
      }
      const applied = workbench.patchHarnessTextSettings({
        refinementModel: flags.digest,
      });
      io.stdout(`The reviewer runs on ${applied.refinementModel}.`);
      return 0;
    } catch (error) {
      io.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  if (!flags.session && !["model", "ratchet"].includes(action)) {
    io.stderr("The harness commands need a session: --session <id>.");
    io.stderr(USAGE);
    return 1;
  }
  if (!["list", "entries", "model", "ratchet"].includes(action) && !flags.digest) {
    io.stderr(`The ${action} action needs the digest of the proposal.`);
    io.stderr(USAGE);
    return 1;
  }
  if (action === "reject" && !flags.reason) {
    io.stderr("A rejection needs a reason: --reason <text>.");
    return 1;
  }
  const env = deps.env ?? process.env;
  if (!deps.workbench) {
    // The workbench writes its storage key when it is constructed, so a
    // command that only reads would create a workspace on a machine that has
    // none. The refusal names the path and the command that creates it.
    const directory = workspaceDir(env);
    if (!existsSync(directory)) {
      io.stderr(`No workspace at ${directory}. Run nomo init first.`);
      return 1;
    }
  }
  const workbench = deps.workbench
    ? await deps.workbench()
    : new Workbench(env);
  try {
    if (action === "ratchet") {
      // The workbench owns the sessions; a test double may not, so the
      // session lookup falls back to a pending-proposals probe.
      let session: { readonly workspace: string } | undefined;
      try {
        session = workbench.get ? workbench.get(flags.session) : undefined;
      } catch {
        session = undefined;
      }
      if (!session) {
        io.stderr("Session not found.");
        return 1;
      }
      const proof = workbench.ledger
        ? await workbench.ledger(session.workspace)
        : undefined;
      const entries = (proof?.entries ?? []) as readonly {
        readonly body: unknown;
        readonly seq: number;
      }[];
      const now = new Date().toISOString();
      io.stdout(
        "The harness board is descriptive only. It never changes a decision or permission.",
      );
      io.stdout("");
      if (!entries.length) {
        io.stdout("No signed entry in this workspace, so there is nothing to measure.");
        return 0;
      }
      const previous = [...entries]
        .reverse()
        .find(
          (entry) =>
            (entry.body as Record<string, unknown> | null)?.decision ===
            "proposal:activated",
        );
      if (!previous) {
        const { measureBoard, scoreCases } = await import(
          "../../workbench/src/harness-scores.ts"
        );
        const current = measureBoard(scoreCases(entries), now);
        io.stdout("No previous refinement: nothing to compare against.");
        io.stdout(
          `Current board: verdict ${current.verdict}, ${current.caseCount} cases, deny_rate ${current.metrics.deny_rate.n} measured.`,
        );
        return 0;
      }
      const baselineIndex = entries.indexOf(previous);
      const { compareBoards, measureBoard, scoreCases, SCORE_GUARDRAILS, SCORE_METRICS } = await import(
        "../../workbench/src/harness-scores.ts"
      );
      const before = measureBoard(scoreCases(entries.slice(0, baselineIndex)), now);
      const after = measureBoard(scoreCases(entries), now);
      const compared = compareBoards(before, after);
      io.stdout(`Baseline: the board before the refinement activated at sequence ${previous.seq}.`);
      io.stdout(`Verdict: ${compared.verdict}`);
      io.stdout("");
      for (const key of SCORE_GUARDRAILS) {
        const metric = SCORE_METRICS[key];
        const b = before.guardrails[key];
        const a = after.guardrails[key];
        const fmt = (summary: { readonly mean: number | null; readonly n: number } | undefined) =>
          summary && summary.mean !== null
            ? `${summary.mean.toFixed(3)} (n=${summary.n})`
            : "unmeasured";
        const moved = compared.guardrailBreaches.includes(key) ? "  REGRESSED" : "";
        io.stdout(
          `${key}  ${metric ? metric.label : key}: ${fmt(b)} -> ${fmt(a)}${moved}`,
        );
      }
      if (compared.guardrailBreaches.length) {
        io.stdout("");
        io.stdout(
          "A guardrail regressed outside noise. This is a report, not a refusal: the workbench decides, and it decides on evidence the harness chain carries.",
        );
      }
      return 0;
    }
    if (action === "entries") {
      const entries = await workbench.harnessEntries(flags.session);
      if (!entries.length) {
        io.stdout("The harness holds no entry for this workspace.");
        return 0;
      }
      for (const entry of entries) {
        const content =
          entry.content.length > 160
            ? `${entry.content.slice(0, 160)}...`
            : entry.content;
        io.stdout(
          `${entry.id}  ${entry.kind}${entry.decidedByOperator ? "  operator" : ""}${
            entry.tool ? `  ${entry.tool}/${entry.klass}` : ""
          }`,
        );
        io.stdout(`    ${entry.title}`);
        io.stdout(`    ${content}`);
        if (entry.rule) {
          io.stdout("    policy rule, paste it into your own file:");
          for (const line of ruleAsPolicyText(entry.rule)) io.stdout(`      ${line}`);
        }
      }
      return 0;
    }
    if (action === "list") {
      const proposals = await workbench.pendingApprovalsFor(flags.session);
      if (!proposals.length) {
        io.stdout("No harness proposal awaits a decision.");
        return 0;
      }
      for (const proposal of proposals) {
        io.stdout(`${proposal.digest}  ${proposal.summary}  ${proposal.at}`);
        for (const edit of proposal.proposal.edits) io.stdout(describeEdit(edit));
      }
      return 0;
    }
    if (action === "approve") {
      const applied = await workbench.approveHarnessProposal(
        flags.session,
        await resolveDigest(workbench, flags.session, flags.digest),
      );
      io.stdout(`Applied ${applied.applied.length} edit(s) from ${flags.digest}.`);
      return 0;
    }
    if (action === "reject") {
      const digest = await resolveDigest(
        workbench,
        flags.session,
        flags.digest,
      );
      await workbench.rejectHarnessProposal(flags.session, digest, flags.reason);
      io.stdout(`Rejected ${digest}.`);
      return 0;
    }
    const rolled = await workbench.rollbackHarnessProposal(
      flags.session,
      await resolveDigest(workbench, flags.session, flags.digest),
    );
    io.stdout(`Rolled back ${flags.digest}: ${rolled.applied.length} edit(s) undone.`);
    return 0;
  } catch (error) {
    // The workbench's own sentence, kept whole. A refusal that is reworded
    // here is a refusal the operator cannot match against the surface that
    // produced it.
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

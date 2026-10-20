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

export type HarnessIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

/** The part of the workbench this command uses. Narrow on purpose: the
 * command is a reader and a decider, and it does not need the run path. */
export type HarnessSurface = {
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
  if (!["list", "entries", "approve", "reject", "rollback", "model"].includes(action)) {
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
  if (!flags.session) {
    io.stderr("The harness commands need a session: --session <id>.");
    io.stderr(USAGE);
    return 1;
  }
  if (!["list", "entries", "model"].includes(action) && !flags.digest) {
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

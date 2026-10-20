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
import { Workbench } from "../../workbench/src/index.ts";

export type HarnessIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

/** The part of the workbench this command uses. Narrow on purpose: the
 * command is a reader and a decider, and it does not need the run path. */
export type HarnessSurface = {
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

const USAGE = [
  "usage:",
  "  nomo harness list --session <id>",
  "  nomo harness approve --session <id> <digest>",
  "  nomo harness reject --session <id> <digest> --reason <text>",
  "  nomo harness rollback --session <id> <digest>",
].join("\n");

type Flags = {
  readonly session: string;
  readonly reason: string;
  readonly digest: string;
  readonly unknown: readonly string[];
};

function parseFlags(args: readonly string[]): Flags {
  let session = "";
  let reason = "";
  let digest = "";
  const unknown: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
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
  return { session, reason, digest, unknown };
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
  if (!["list", "approve", "reject", "rollback"].includes(action)) {
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
  if (!flags.session) {
    io.stderr("The harness commands need a session: --session <id>.");
    io.stderr(USAGE);
    return 1;
  }
  if (action !== "list" && !flags.digest) {
    io.stderr(`The ${action} action needs the digest of the proposal.`);
    io.stderr(USAGE);
    return 1;
  }
  if (action === "reject" && !flags.reason) {
    io.stderr("A rejection needs a reason: --reason <text>.");
    return 1;
  }
  const workbench = deps.workbench
    ? await deps.workbench()
    : new Workbench(deps.env ?? process.env);
  try {
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
        flags.digest,
      );
      io.stdout(`Applied ${applied.applied.length} edit(s) from ${flags.digest}.`);
      return 0;
    }
    if (action === "reject") {
      await workbench.rejectHarnessProposal(
        flags.session,
        flags.digest,
        flags.reason,
      );
      io.stdout(`Rejected ${flags.digest}.`);
      return 0;
    }
    const rolled = await workbench.rollbackHarnessProposal(
      flags.session,
      flags.digest,
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

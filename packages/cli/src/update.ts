/**
 * Self-update for a git-installed tree.
 *
 * NOMO ships as a clone plus a launcher, so "update" is a git fast-forward and
 * a dependency install. There is no registry to publish to and no tarball to
 * download: every workspace manifest is private, so there is nothing to fetch
 * from a registry even if a registry were reachable. The installed tree is
 * therefore moved by git, and this module refuses rather than guesses.
 *
 * Two refusals are load-bearing and neither is configurable:
 *
 * - A dirty worktree is never overwritten, not even by `--force`. A move would
 *   destroy edits the operator made in the install directory, and no flag is a
 *   good enough reason to delete someone's work.
 * - A local commit is never dropped, not even by `git reset --hard`. The
 *   default refuses a non-fast-forward outright; `--force` is the operator
 *   saying out loud that the local commits may go, and it moves with
 *   `reset --keep` rather than `--hard` so that even a mistake stops at an
 *   uncommitted file instead of eating it.
 *
 * Argument parsing, the tree resolution and the decision of what to do are pure
 * and exported. The git and pnpm calls live in the thin shell below them, so
 * the rules above are testable without a repository on disk.
 *
 * Exit codes, because a CI gate is the first thing that will call this:
 *
 * - 0: up to date, the update was applied, or the check answered and there is
 *   nothing to install now (including an update that exists but is refused,
 *   and a check that could not reach the remote).
 * - 1: the update could not be completed and the tree was left where it was,
 *   or there is no updatable tree to speak of.
 * - 2: usage.
 * - 3: `--check` only, and the single answer a script should branch on: an
 *   update is available. It is three rather than one because a caller has to
 *   be able to tell "an update exists" from "the check failed" without
 *   parsing prose.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type UpdateIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

export type UpdateDeps = {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /**
   * The version of the code that is running this command, supplied by the
   * caller's `packageVersion()`. The binary has one version reader and this
   * command is not a place to add a second.
   */
  readonly version?: string;
};

const UPDATE_USAGE = "usage: nomo update [--check] [--force]";

/**
 * The installer that creates an updatable tree. Named in every refusal that
 * leaves the operator without one, because "this is not a git checkout" is not
 * an instruction.
 */
const INSTALLER = "scripts/install-nomo.sh";

/**
 * The tree the running code was loaded from. This file sits at
 * `<tree>/packages/cli/src/update.ts`, so the tree is three levels up. It is
 * the last fallback: an installed tree is named by `NOMO_HOME` or by `HOME`,
 * and only a checkout run in place has nothing else to go on.
 */
const SOURCE_TREE = fileURLToPath(new URL("../../../", import.meta.url));

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const short = (commit: string) => commit.slice(0, 12);

export type UpdateOptions = {
  /** The only tree this command is allowed to move. */
  readonly home: string;
  /** `--check`: report the installed state and change nothing. */
  readonly check: boolean;
  /** `--force`: allow dropping local commits. Never allows a dirty tree. */
  readonly force: boolean;
};

export type UpdateFlags = { readonly check: boolean; readonly force: boolean };

/** Flags carry a value, a bare word is a subcommand, an unknown `--flag` is a
 * refusal. `--check` and `--force` cannot be combined, because one of them
 * decides that the tree is left alone and the other that it may be moved. */
export function parseUpdateArgs(argv: readonly string[]): UpdateFlags {
  let check = false;
  let force = false;
  for (const arg of argv) {
    if (arg === "--check") check = true;
    else if (arg === "--force") force = true;
    else throw Error(UPDATE_USAGE);
  }
  if (check && force)
    throw Error("--check only reports; it cannot be combined with --force");
  return { check, force };
}

/**
 * `$NOMO_HOME` wins, then the location the installer uses, then the tree this
 * file was loaded from.
 *
 * The default is `nomo-cli` and not `nomo` because `scripts/install-nomo.sh`
 * writes that name into the launcher it installs, and this command has to land
 * on the same tree the launcher runs from. It is spelled out here rather than
 * imported from the installer because a shell script is not a module, and two
 * copies of one path is the smaller problem next to a refusal on every real
 * run.
 */
export function resolveUpdateHome(
  env: Readonly<NodeJS.ProcessEnv>,
  sourceTree: string,
): string {
  return (
    env.NOMO_HOME ??
    (env.HOME ? join(env.HOME, ".local", "share", "nomo-cli") : sourceTree)
  );
}

export type UpdateFacts = {
  /** The commit the tree has checked out. */
  readonly installedCommit: string;
  /** The commit the tracked branch points at. */
  readonly targetCommit: string;
  /** A tracked file differs from the index, so a move would overwrite work. */
  readonly dirty: boolean;
  /** Local commits the tracked branch does not contain. */
  readonly ahead: number;
};

export type UpdatePlan =
  | { readonly kind: "current" }
  | { readonly kind: "fast-forward" }
  | { readonly kind: "move" }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * The whole policy of the command, as one pure function.
 *
 * `current` is decided before the refusals, and deliberately: there is nothing
 * to move, so the state of the worktree cannot be destroyed by reporting that
 * the tree is already where the remote is.
 */
export function planUpdate(facts: UpdateFacts, force: boolean): UpdatePlan {
  if (facts.installedCommit === facts.targetCommit) return { kind: "current" };
  if (facts.dirty)
    return {
      kind: "refuse",
      reason:
        "the installed tree has uncommitted changes; commit or discard them first. --force does not discard uncommitted work.",
    };
  if (facts.ahead > 0 && !force)
    return {
      kind: "refuse",
      reason: `the installed tree has ${facts.ahead} local commit${facts.ahead === 1 ? "" : "s"} the tracked branch does not have, and moving would drop ${facts.ahead === 1 ? "it" : "them"}. Give it a branch, or re-run with --force.`,
    };
  return { kind: facts.ahead > 0 ? "move" : "fast-forward" };
}

/** A refusal that leaves the operator with no updatable tree. Both cases name
 * the installer, because naming the way out is the useful half. */
function noCheckout(home: string): string {
  return existsSync(home)
    ? `${home} is not a git checkout. Reinstall it with ${INSTALLER}, or point NOMO_HOME at the checkout you want to update.`
    : `no installed tree at ${home}. Run ${INSTALLER} to create one, or point NOMO_HOME at an existing checkout.`;
}

type GitResult =
  | { readonly ok: true; readonly out: string }
  | { readonly ok: false; readonly error: string };

/**
 * Every git call is an argument array, never a shell string: the tree path
 * comes from the environment and is not a value this command may interpolate
 * into a command line.
 */
function git(home: string, args: readonly string[]): GitResult {
  const run = spawnSync("git", [...args], { cwd: home, encoding: "utf8" });
  if (run.error) return { ok: false, error: run.error.message };
  if (run.status !== 0)
    return {
      ok: false,
      error:
        (run.stderr ?? "").trim() ||
        (run.stdout ?? "").trim() ||
        `git ${args[0] ?? ""} failed`,
    };
  return { ok: true, out: (run.stdout ?? "").trim() };
}

/** Untracked files do not block a fast-forward and are not edits, so only a
 * difference in a tracked file counts as dirty. */
function readFacts(
  home: string,
  upstream: string,
): { readonly ok: true; readonly facts: UpdateFacts } | { readonly ok: false; readonly error: string } {
  const head = git(home, ["rev-parse", "HEAD"]);
  if (!head.ok) return head;
  const target = git(home, ["rev-parse", upstream]);
  if (!target.ok) return target;
  const ahead = git(home, ["rev-list", "--count", `${upstream}..HEAD`]);
  if (!ahead.ok) return ahead;
  const status = git(home, ["status", "--porcelain", "--untracked-files=no"]);
  if (!status.ok) return status;
  return {
    ok: true,
    facts: {
      installedCommit: head.out,
      targetCommit: target.out,
      dirty: status.out.length > 0,
      ahead: Number.parseInt(ahead.out, 10) || 0,
    },
  };
}

/**
 * The dependencies of the new source, installed with the lockfile the
 * repository ships. pnpm's own output is captured and re-emitted through
 * `io` rather than inherited: this command has one output channel, and a
 * child writing straight to the process would put pnpm's progress stream in
 * the middle of it. Its failure is prefixed rather than passed on raw,
 * because the next line says what the operator has to do about it.
 */
function installDependencies(home: string, io: UpdateIo): number {
  const run = spawnSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: home,
    encoding: "utf8",
  });
  if (run.error) {
    io.stderr(
      `pnpm could not be run to install dependencies: ${run.error.message}`,
    );
    return 1;
  }
  if (run.status !== 0)
    for (const line of `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n"))
      if (line.trim()) io.stderr(`pnpm: ${line}`);
  return run.status ?? 1;
}

export async function runUpdateCommand(
  argv: readonly string[],
  io: UpdateIo,
  deps: UpdateDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  let options: UpdateOptions;
  try {
    options = {
      home: resolveUpdateHome(env, SOURCE_TREE),
      ...parseUpdateArgs(argv),
    };
  } catch (error) {
    io.stderr(message(error));
    return 2;
  }
  const home = options.home;
  if (!existsSync(join(home, ".git"))) {
    io.stderr(noCheckout(home));
    return 1;
  }
  // A tree with no upstream has no target, and inventing one would be a move
  // the operator did not ask for.
  const upstream = git(home, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);
  if (!upstream.ok) {
    io.stderr(
      `${home} tracks no upstream branch, so there is no target to update to.`,
    );
    return 1;
  }
  const head = git(home, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    io.stderr(`git could not read the installed commit: ${head.error}`);
    return 1;
  }
  // One fact per line, `key: value`, full hashes. A script reads these with
  // `cut` and never with a pattern that has to survive reformatting; the
  // verdict below is the line a human reads.
  io.stdout(`installed: nomo ${deps.version ?? "unknown"} at ${home}`);
  io.stdout(`installed-commit: ${head.out}`);
  io.stdout(`tracked-branch: ${upstream.out}`);

  // A check that cannot see the remote is not a check, so the fetch happens in
  // both modes. It moves no working-tree file and no checked-out commit, so
  // `--check` still changes nothing the operator can lose.
  const fetched = git(home, ["fetch", "--quiet"]);
  if (!fetched.ok) {
    io.stdout(`target-commit: unknown (git fetch failed: ${fetched.error})`);
    io.stderr(`git fetch failed: ${fetched.error}`);
    // The question "is there an update" was not answered, which is not the
    // same answer as "no". It is reported as unknown rather than as zero,
    // because a CI gate cannot tell those apart from an exit code alone.
    if (options.check) return 0;
    return 1;
  }

  const facts = readFacts(home, upstream.out);
  if (!facts.ok) {
    io.stderr(`git could not read the installed state: ${facts.error}`);
    return 1;
  }
  io.stdout(`target-commit: ${facts.facts.targetCommit}`);
  const plan = planUpdate(facts.facts, options.force);

  if (options.check) {
    // `current` is the only plan here that means there is nothing to install.
    // Everything else means the tracked branch is ahead of the tree, and that
    // is true of a refusal too: a dirty worktree does not make an available
    // update stop existing, it makes this command decline to apply it.
    if (plan.kind === "current") {
      io.stdout("up to date");
      return 0;
    }
    if (plan.kind === "refuse") {
      io.stdout(`update available, not applied: ${plan.reason}`);
      return 3;
    }
    io.stdout("update available: run `nomo update`");
    return 3;
  }

  if (plan.kind === "current") {
    io.stdout("nothing to do: the tree already sits on the tracked branch");
    return 0;
  }
  if (plan.kind === "refuse") {
    io.stderr(`update refused: ${plan.reason}`);
    return 1;
  }
  if (plan.kind === "fast-forward")
    io.stdout(`fast-forward: git merge --ff-only ${upstream.out}`);
  else
    io.stdout(`moving onto ${short(facts.facts.targetCommit)}: git reset --keep`);
  const moved =
    plan.kind === "fast-forward"
      ? git(home, ["merge", "--ff-only", upstream.out])
      : git(home, ["reset", "--keep", facts.facts.targetCommit]);
  if (!moved.ok) {
    io.stderr(`git could not move the tree: ${moved.error}`);
    return 1;
  }
  const code = installDependencies(home, io);
  if (code !== 0) {
    io.stderr(
      "the tree was moved, but its dependencies were not installed; run `pnpm install --frozen-lockfile` in it",
    );
    return code;
  }
  io.stdout(`updated to ${short(facts.facts.targetCommit)}`);
  return 0;
}

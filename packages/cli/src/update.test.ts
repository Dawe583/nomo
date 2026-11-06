import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseUpdateArgs,
  planUpdate,
  resolveUpdateHome,
  runUpdateCommand,
  type UpdateFacts,
} from "./update.ts";

function collect() {
  const out: string[] = [],
    err: string[] = [];
  return {
    io: {
      stdout: (line: string) => void out.push(line),
      stderr: (line: string) => void err.push(line),
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

const facts = (over: Partial<UpdateFacts> = {}): UpdateFacts => ({
  installedCommit: "a".repeat(40),
  targetCommit: "b".repeat(40),
  dirty: false,
  ahead: 0,
  ...over,
});

const onTargetFacts = (): UpdateFacts =>
  facts({
    installedCommit: "a".repeat(40),
    targetCommit: "a".repeat(40),
  });

/** A real clone with a real remote. The policy under test is about commits and
 * worktrees, and a test double for `git status` would be testing the double. */
function git(cwd: string, args: readonly string[]): string {
  const run = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  assert.equal(
    run.status,
    0,
    `git ${args.join(" ")} failed: ${run.stderr || run.stdout}`,
  );
  return run.stdout.trim();
}

/** Commits without touching the operator's global git config. */
async function commit(tree: string, name: string, body: string): Promise<void> {
  await writeFile(join(tree, name), body);
  git(tree, ["add", name]);
  git(tree, [
    "-c",
    "user.email=void@example.invalid",
    "-c",
    "user.name=void",
    "commit",
    "-m",
    `add ${name}`,
  ]);
}

/** A clone that tracks `origin/main`, plus the bare remote behind it. */
async function installedTree(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), "nomo-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const tree = join(root, "tree");
  git(root, ["init", "--bare", "--quiet", remote]);
  git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(root, ["clone", "--quiet", remote, tree]);
  await commit(tree, "one.txt", "one");
  git(tree, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  git(tree, ["branch", "--set-upstream-to=origin/main"]);
  return { root, remote, tree };
}

/** Publishes a commit the installed tree has not seen, and returns its sha. */
async function publish(
  remote: string,
  tree: string,
  name: string,
): Promise<string> {
  const publisher = join(remote, "..", `publisher-${name}`);
  git(tree, ["clone", "--quiet", remote, publisher]);
  await commit(publisher, name, name);
  git(publisher, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);
  return git(publisher, ["rev-parse", "HEAD"]);
}

/**
 * Makes the tree an installable project, so the default path can be run all the
 * way through. A project with no dependencies resolves and links offline, which
 * is what keeps this a test of the command rather than of the network.
 */
async function makeInstallable(tree: string): Promise<void> {
  await writeFile(
    join(tree, "package.json"),
    `${JSON.stringify({ name: "nomo-update-test", version: "0.0.0", private: true }, null, 2)}\n`,
  );
  const lock = spawnSync("pnpm", ["install", "--lockfile-only"], {
    cwd: tree,
    encoding: "utf8",
  });
  assert.equal(
    lock.status,
    0,
    `pnpm could not write a lockfile: ${lock.stderr}`,
  );
}

test("update refuses an unknown flag with usage and exit two", async () => {
  const c = collect();
  const code = await runUpdateCommand(["--force-update"], c.io, { env: {} });
  assert.equal(code, 2);
  assert.deepEqual(c.err, ["usage: nomo update [--check] [--force]"]);
  assert.deepEqual(c.out, []);
});

test("update refuses --check combined with --force, because one moves the tree and the other promises not to", () => {
  assert.deepEqual(parseUpdateArgs([]), { check: false, force: false });
  assert.deepEqual(parseUpdateArgs(["--check"]), { check: true, force: false });
  assert.deepEqual(parseUpdateArgs(["--force"]), { check: false, force: true });
  assert.throws(
    () => parseUpdateArgs(["--check", "--force"]),
    /--check only reports/,
  );
  assert.throws(() => parseUpdateArgs(["--canary"]), /usage: nomo update/);
});

test("the tree is NOMO_HOME, else the installer's location, else the source tree", () => {
  assert.equal(
    resolveUpdateHome(
      { NOMO_HOME: "/opt/void", HOME: "/home/op" },
      "/src/tree",
    ),
    "/opt/void",
  );
  // `nomo-cli`, and not `nomo`: this has to be the tree the installed
  // launcher runs from, which is what the installer names in that launcher.
  assert.equal(
    resolveUpdateHome({ HOME: "/home/op" }, "/src/tree"),
    join("/home/op", ".local", "share", "nomo-cli"),
  );
  // Neither variable: a checkout run in place is the only tree there is.
  assert.equal(resolveUpdateHome({}, "/src/tree"), "/src/tree");
});

test("a tree that is not a git checkout is refused, and the refusal names the installer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-update-bare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "not-a-clone"));

  const missing = collect();
  assert.equal(
    await runUpdateCommand([], missing.io, {
      env: { NOMO_HOME: join(root, "gone") },
    }),
    1,
  );
  assert.match(missing.err[0] ?? "", /no installed tree at/);
  assert.match(missing.err[0] ?? "", /scripts\/install-nomo\.sh/);

  const notAClone = collect();
  assert.equal(
    await runUpdateCommand([], notAClone.io, {
      env: { NOMO_HOME: join(root, "not-a-clone") },
    }),
    1,
  );
  assert.match(notAClone.err[0] ?? "", /is not a git checkout/);
  assert.match(notAClone.err[0] ?? "", /scripts\/install-nomo\.sh/);
  // A directory that exists but is not a tree is not a tree under a check
  // either, and saying so is the whole answer.
  const checked = collect();
  assert.equal(
    await runUpdateCommand(["--check"], checked.io, {
      env: { NOMO_HOME: join(root, "not-a-clone") },
    }),
    1,
  );
});

test("--check reports an up-to-date tree without changing it, and exits zero", async (t) => {
  const { tree } = await installedTree(t);
  const before = git(tree, ["rev-parse", "HEAD"]);

  const c = collect();
  const code = await runUpdateCommand(["--check"], c.io, {
    env: { NOMO_HOME: tree },
    version: "0.1.0",
  });
  assert.equal(code, 0);
  // One fact per line, in full, so a script reads these with `cut` and never
  // with a pattern that has to survive reformatting.
  assert.deepEqual(c.out, [
    `installed: nomo 0.1.0 at ${tree}`,
    `installed-commit: ${before}`,
    "tracked-branch: origin/main",
    `target-commit: ${before}`,
    "up to date",
  ]);
  assert.deepEqual(c.err, []);
  // "Changes nothing" is the promise, so it is checked rather than claimed.
  assert.equal(git(tree, ["rev-parse", "HEAD"]), before);
  assert.equal(existsSync(join(tree, "node_modules")), false);
});

test("--check exits three when an update is available, and moves nothing", async (t) => {
  const { tree, remote } = await installedTree(t);
  const before = git(tree, ["rev-parse", "HEAD"]);
  const published = await publish(remote, tree, "two.txt");

  const c = collect();
  const code = await runUpdateCommand(["--check"], c.io, {
    env: { NOMO_HOME: tree },
    version: "0.1.0",
  });
  // Three, not one: the caller has to be able to branch on "an update exists"
  // without reading the output.
  assert.equal(code, 3);
  assert.equal(
    c.out.find((line) => line.startsWith("target-commit: ")),
    `target-commit: ${published}`,
  );
  assert.equal(c.out.at(-1), "update available: run `nomo update`");
  assert.equal(git(tree, ["rev-parse", "HEAD"]), before);
  assert.equal(existsSync(join(tree, "two.txt")), false);
});

test("a dirty worktree is refused and left alone, and --force does not override it", async (t) => {
  const { tree, remote } = await installedTree(t);
  const published = await publish(remote, tree, "two.txt");
  const before = git(tree, ["rev-parse", "HEAD"]);
  const edit = join(tree, "one.txt");
  await writeFile(edit, "operator edit");
  // Refused even with --force, and even though there are local commits to drop
  // as well: an uncommitted edit is work, and no flag outranks that.
  assert.deepEqual(planUpdate(facts({ dirty: true, ahead: 3 }), true), {
    kind: "refuse",
    reason:
      "the installed tree has uncommitted changes; commit or discard them first. --force does not discard uncommitted work.",
  });

  const forced = collect();
  assert.equal(
    await runUpdateCommand(["--force"], forced.io, {
      env: { NOMO_HOME: tree },
    }),
    1,
  );
  assert.match(forced.err.join("\n"), /uncommitted changes/);
  assert.match(
    forced.err.join("\n"),
    /--force does not discard uncommitted work/,
  );
  // The point of refusing rather than moving: the edit survives, and so does
  // the commit it was made on top of.
  assert.equal(await readFile(edit, "utf8"), "operator edit");
  assert.equal(git(tree, ["rev-parse", "HEAD"]), before);
  assert.equal(git(tree, ["status", "--porcelain"]), "M one.txt");
  // The check sees the same update and the same blocker, and says three: the
  // update exists whether or not this command is allowed to apply it.
  const checked = collect();
  assert.equal(
    await runUpdateCommand(["--check"], checked.io, {
      env: { NOMO_HOME: tree },
    }),
    3,
  );
  assert.match(
    checked.out.at(-1) ?? "",
    /^update available, not applied: the installed tree has uncommitted changes/,
    checked.out.join("\n"),
  );
  assert.notEqual(published, before);
});

test("local commits are refused, and only --force allows dropping them", async (t) => {
  const { tree, remote } = await installedTree(t);
  await commit(tree, "local.txt", "local work");
  const local = git(tree, ["rev-parse", "HEAD"]);

  const refused = collect();
  assert.equal(
    await runUpdateCommand([], refused.io, { env: { NOMO_HOME: tree } }),
    1,
  );
  assert.match(
    refused.err.join("\n"),
    /has 1 local commit the tracked branch does not have, and moving would drop it/,
  );
  assert.equal(git(tree, ["rev-parse", "HEAD"]), local);
  assert.equal(existsSync(join(tree, "local.txt")), true);

  // The two refusals, stated once each, because the count is in the sentence
  // an operator has to read and a wrong count is a wrong warning.
  assert.deepEqual(planUpdate(facts({ ahead: 1 }), false), {
    kind: "refuse",
    reason:
      "the installed tree has 1 local commit the tracked branch does not have, and moving would drop it. Give it a branch, or re-run with --force.",
  });
  assert.deepEqual(planUpdate(facts({ ahead: 2 }), false), {
    kind: "refuse",
    reason:
      "the installed tree has 2 local commits the tracked branch does not have, and moving would drop them. Give it a branch, or re-run with --force.",
  });
  // --force changes exactly one thing: whether a local commit may go. A clean
  // tree still fast-forwards, and a dirty one is still refused.
  assert.deepEqual(planUpdate(facts({ ahead: 2 }), true), { kind: "move" });
  assert.deepEqual(planUpdate(facts({ ahead: 0 }), true), {
    kind: "fast-forward",
  });

  // Against a real tree with a newer target as well, the check says the update
  // exists, names the commits it would drop, and drops nothing.
  const published = await publish(remote, tree, "two.txt");
  const stale = collect();
  assert.equal(
    await runUpdateCommand(["--check"], stale.io, { env: { NOMO_HOME: tree } }),
    3,
  );
  assert.equal(
    stale.out.at(-1),
    "update available, not applied: the installed tree has 1 local commit the tracked branch does not have, and moving would drop it. Give it a branch, or re-run with --force.",
    stale.out.join("\n"),
  );
  assert.equal(
    stale.out.find((line) => line.startsWith("target-commit: ")),
    `target-commit: ${published}`,
  );
  assert.equal(git(tree, ["rev-parse", "HEAD"]), local);
  assert.equal(existsSync(join(tree, "local.txt")), true);
});

test("the default path fast-forwards the tree onto the target and installs its dependencies", async (t) => {
  // The decision itself, which is the part with a rule in it.
  assert.deepEqual(planUpdate(facts(), false), { kind: "fast-forward" });
  assert.deepEqual(planUpdate(onTargetFacts(), false), { kind: "current" });
  // Already on target wins over a refusal: nothing is moving, so a dirty
  // worktree has nothing to lose.
  assert.deepEqual(
    planUpdate({ ...onTargetFacts(), dirty: true, ahead: 4 }, false),
    { kind: "current" },
  );

  const { tree, remote } = await installedTree(t);
  await makeInstallable(tree);
  const lockBefore = await readFile(join(tree, "pnpm-lock.yaml"), "utf8");
  const before = git(tree, ["rev-parse", "HEAD"]);
  const published = await publish(remote, tree, "two.txt");
  assert.notEqual(before, published);

  const c = collect();
  const code = await runUpdateCommand([], c.io, {
    env: { NOMO_HOME: tree },
    version: "0.1.0",
  });
  assert.equal(code, 0, c.err.join("\n"));
  assert.equal(
    c.out.find((line) => line.startsWith("fast-forward: ")),
    "fast-forward: git merge --ff-only origin/main",
  );
  assert.equal(c.out.at(-1), `updated to ${published.slice(0, 12)}`);
  // The two things the command promised, observed rather than assumed: the
  // tree is on the target commit, and the new source's dependencies resolved.
  assert.equal(git(tree, ["rev-parse", "HEAD"]), published);
  // `--frozen-lockfile` never rewrites the lockfile, so it coming back
  // byte-identical is the observable proof that the dependency step ran
  // against the manifest as given rather than resolving something new, and
  // node_modules existing is the proof that it did not skip the step.
  assert.equal(
    await readFile(join(tree, "pnpm-lock.yaml"), "utf8"),
    lockBefore,
  );
  assert.equal(existsSync(join(tree, "node_modules")), true);
});

test("a tree already on the target does nothing and exits zero", async (t) => {
  const { tree } = await installedTree(t);

  const c = collect();
  assert.equal(
    await runUpdateCommand([], c.io, { env: { NOMO_HOME: tree } }),
    0,
  );
  assert.equal(
    c.out.at(-1),
    "nothing to do: the tree already sits on the tracked branch",
    c.out.join("\n"),
  );
  // Nothing to do means nothing was run: a tree with no manifest at all would
  // have failed the install step had the command gone on to it.
  assert.deepEqual(c.err, []);
});

test("a tree with no upstream branch is refused, because there is no target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-update-noupstream-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tree = join(root, "tree");
  await mkdir(tree);
  git(root, ["init", "--quiet", tree]);
  await commit(tree, "one.txt", "one");

  const c = collect();
  // One, not three: with no upstream there is no target, so "an update
  // exists" is not a question this check can answer, and three would claim
  // there is something to install.
  assert.equal(
    await runUpdateCommand(["--check"], c.io, { env: { NOMO_HOME: tree } }),
    1,
  );
  assert.match(c.err.join("\n"), /tracks no upstream branch/);
  assert.ok(!c.out.some((line) => line.startsWith("target-commit: ")));
  assert.ok(!c.out.includes("up to date"));
});

test("a check that cannot reach the remote says the target is unknown, not that it is current", async (t) => {
  const { tree, remote } = await installedTree(t);
  const before = git(tree, ["rev-parse", "HEAD"]);
  await rm(remote, { recursive: true, force: true });

  const c = collect();
  assert.equal(
    await runUpdateCommand(["--check"], c.io, { env: { NOMO_HOME: tree } }),
    0,
  );
  assert.match(c.err.join("\n"), /git fetch failed/);
  // The facts the check did establish are still reported, because losing them
  // costs the operator the one thing they asked for.
  assert.equal(
    c.out.find((line) => line.startsWith("installed-commit: ")),
    `installed-commit: ${before}`,
  );
  // And it does not claim the tree is up to date, which is what a caller would
  // otherwise read that zero as.
  assert.match(
    c.out.find((line) => line.startsWith("target-commit: ")) ?? "",
    /^target-commit: unknown \(git fetch failed: /,
  );
  assert.ok(!c.out.includes("up to date"));
});

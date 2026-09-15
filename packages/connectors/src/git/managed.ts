/** Managed Git owns one cooperative POSIX worktree or index surface at a time. */
import {
  constants,
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Json, Observation, Outcome, Prepared, RecoveryAdapter, RecoveryOutcome } from "../recovery.ts";
import { createManagedCommitLifecycle } from "./managed-commit.ts";
import type { CommitCapture, CommitMutation, CommitPlan } from "./managed-commit.ts";

type LegacyMutation =
  | { action: "write"; path: string; base64: string; mode?: number }
  | { action: "delete"; path: string }
  | { action: "rename"; path: string; to: string }
  | { action: "stage" | "unstage"; path: string };
type Mutation = LegacyMutation | CommitMutation;
type Worktree = { present: false; revision: string } | { present: true; bytes: string; digest: string; size: number; mode: number; revision: string };
type IndexEntry = { present: false } | { present: true; mode: string; oid: string; stage: number };
type State = { head: string; indexRevision: string; worktree: Worktree; index: IndexEntry; destination?: Worktree; destinationIndex?: IndexEntry };
type Capture = { mutation: LegacyMutation; state: State };
type Plan = { root: string; gitDir: string; commonDir: string; indexPath: string; objectFormat: string; identity: string; mutation: LegacyMutation; after: State };
const maxBytes = 1024 * 1024;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = isDeepStrictEqual;

export function managedGitAdapter(options: { root: string; cooperative: true }): RecoveryAdapter {
  if (options.cooperative !== true) throw new Error("Explicit cooperative repository ownership is required.");
  if (process.platform === "win32") throw new Error("Managed Git recovery is POSIX only.");
  const root = realpathSync(resolve(options.root));
  if (!lstatSync(root).isDirectory()) throw new Error("Git root must be a directory.");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GCM_INTERACTIVE: "never",
  };
  const git = (args: readonly string[], input?: Buffer | string, extraEnv: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      env: { ...env, ...extraEnv },
      input,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: 15_000,
    });
    if (result.status !== 0 || result.signal || result.error || result.stderr) throw new Error("Managed Git command failed.");
    return result.stdout.trim();
  };
  if (git(["rev-parse", "--is-bare-repository"]) !== "false") throw new Error("Bare repositories are unsupported.");
  if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== root) throw new Error("Configured root must be the canonical worktree root.");
  const gitDir = realpathSync(git(["rev-parse", "--absolute-git-dir"]));
  const commonLocation = git(["rev-parse", "--git-common-dir"]);
  const commonDir = realpathSync(isAbsolute(commonLocation) ? commonLocation : join(root, commonLocation));
  const objectFormat = git(["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("Unsupported Git object format.");
  const oidPattern = objectFormat === "sha1" ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  const indexLocation = git(["rev-parse", "--git-path", "index"]);
  const indexPath = isAbsolute(indexLocation) ? indexLocation : join(root, indexLocation);
  const stat = lstatSync(root, { bigint: true });
  const identity = digest([root, gitDir, commonDir, indexPath, objectFormat, String(stat.dev), String(stat.ino)]);
  function currentIdentity() {
    const current = lstatSync(root, { bigint: true });
    if (!current.isDirectory()) throw new Error("Git repository identity changed.");
    const currentGitDir = realpathSync(git(["rev-parse", "--absolute-git-dir"]));
    const location = git(["rev-parse", "--git-common-dir"]);
    const currentCommonDir = realpathSync(isAbsolute(location) ? location : join(root, location));
    const currentIndexLocation = git(["rev-parse", "--git-path", "index"]);
    const currentIndexPath = isAbsolute(currentIndexLocation) ? currentIndexLocation : join(root, currentIndexLocation);
    const currentObjectFormat = git(["rev-parse", "--show-object-format"]);
    return digest([root, currentGitDir, currentCommonDir, currentIndexPath, currentObjectFormat, String(current.dev), String(current.ino)]);
  }

  function readIndexState(path = indexPath) {
    const bytes = readFileSync(path);
    if (bytes.length > 16 * 1024 * 1024 || bytes.length < 12 + (objectFormat === "sha1" ? 20 : 32)) throw new Error("Unsupported Git index format.");
    if (bytes.subarray(0, 4).toString("ascii") !== "DIRC" || bytes.readUInt32BE(4) !== 2) throw new Error("Unsupported Git index format.");
    const hashLength = objectFormat === "sha1" ? 20 : 32, count = bytes.readUInt32BE(8), contentEnd = bytes.length - hashLength;
    const expectedChecksum = createHash(objectFormat).update(bytes.subarray(0, contentEnd)).digest();
    if (!expectedChecksum.equals(bytes.subarray(contentEnd))) throw new Error("Invalid Git index checksum.");
    let offset = 12;
    const entries: { path: string; fixed: string; mode: string; oid: string; flags: number }[] = [];
    for (let entry = 0; entry < count; entry++) {
      const start = offset, fixed = 40 + hashLength + 2;
      if (offset + fixed > contentEnd) throw new Error("Invalid Git index entry.");
      const flags = bytes.readUInt16BE(offset + 40 + hashLength);
      if ((flags & 0xf000) !== 0) throw new Error("Unsupported index entry flags.");
      offset += fixed;
      const nul = bytes.indexOf(0, offset);
      if (nul < offset || nul >= contentEnd) throw new Error("Invalid Git index entry.");
      const rawPath = bytes.subarray(offset, nul), decodedPath = rawPath.toString("utf8");
      if (!Buffer.from(decodedPath, "utf8").equals(rawPath) || (flags & 0x0fff) !== Math.min(rawPath.length, 0x0fff)) throw new Error("Invalid Git index pathname.");
      const aligned = start + Math.ceil((nul + 1 - start) / 8) * 8;
      for (let padding = nul + 1; padding < aligned; padding++) if (bytes[padding] !== 0) throw new Error("Invalid Git index padding.");
      entries.push({ path: decodedPath, fixed: bytes.subarray(start, start + 40).toString("hex"), mode: bytes.readUInt32BE(start + 24).toString(8).padStart(6, "0"), oid: bytes.subarray(start + 40, start + 40 + hashLength).toString("hex"), flags });
      offset = aligned;
    }
    while (offset < contentEnd) {
      if (offset + 8 > contentEnd) throw new Error("Invalid Git index extension.");
      const signature = bytes.subarray(offset, offset + 4).toString("ascii"), size = bytes.readUInt32BE(offset + 4);
      if (signature !== "TREE" || offset + 8 + size > contentEnd) throw new Error("Unsupported Git index extension.");
      offset += 8 + size;
    }
    if (offset !== contentEnd) throw new Error("Invalid Git index boundary.");
    const item = lstatSync(path, { bigint: true });
    return { revision: digest([createHash("sha256").update(bytes).digest("hex"), String(item.dev), String(item.ino), String(item.ctimeNs)]), entries };
  }
  const indexRevision = () => readIndexState().revision;

  function validateRepository() {
    if (currentIdentity() !== identity)
      throw new Error("Git repository identity changed.");
    if (existsSync(`${indexPath}.lock`)) throw new Error("Git index is locked.");
    if (git(["update-index", "--show-index-version"]) !== "2") throw new Error("Unsupported Git index format.");
    if (git(["rev-parse", "--shared-index-path"])) throw new Error("Split index is unsupported.");
    indexRevision();
    if (git(["ls-files", "--unmerged", "-z"])) throw new Error("Unmerged index entries are unsupported.");
    const flags = git(["ls-files", "-v", "-z"]);
    if (flags && flags.split("\0").some((entry) => entry && !entry.startsWith("H "))) throw new Error("Unsupported index entry flags.");
    const sparse = git(["config", "--null", "--list"]).split("\0").some((entry) => /^core\.sparsecheckout(?:=|\n)true$/i.test(entry));
    if (sparse || existsSync(join(gitDir, "info", "sparse-checkout"))) throw new Error("Sparse checkout is unsupported.");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "BISECT_START", "AUTO_MERGE", "sequencer", "rebase-apply", "rebase-merge"]) {
      const path = git(["rev-parse", "--git-path", marker]);
      if (existsSync(isAbsolute(path) ? path : join(root, path))) throw new Error("Active Git operation is unsupported.");
    }
  }
  function pathTarget(path: string) {
    if (typeof path !== "string" || !path || path.length > 1024 || isAbsolute(path) || path.includes("\\") || path.includes("\0")) throw new Error("Invalid Git path.");
    const parts = path.split("/");
    if (parts.some((part) => !part || part === "." || part === ".." || /^\.git$/i.test(part))) throw new Error("Protected or invalid Git path.");
    let parent = root;
    for (const [index, part] of parts.entries()) {
      if (existsSync(parent) && !readdirSync(parent).includes(part) && existsSync(join(parent, part))) throw new Error("Git path spelling is not canonical.");
      if (index === parts.length - 1) break;
      parent = join(parent, part);
      const item = lstatSync(parent);
      if (!item.isDirectory() || item.isSymbolicLink()) throw new Error("Unsafe Git path parent.");
    }
    const absolute = join(root, path);
    for (const admin of [gitDir, commonDir]) if (absolute === admin || absolute.startsWith(`${admin}/`)) throw new Error("Git administrative paths are protected.");
    return absolute;
  }
  function parse(args: Json): Mutation {
    if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("Invalid Git mutation.");
    const value = args as Record<string, unknown>;
    if (typeof value.action !== "string" || typeof value.path !== "string") throw new Error("Invalid Git mutation.");
    pathTarget(value.path);
    if (value.action === "commit") {
      if (Object.keys(value).some((key) => !["action", "path"].includes(key)))
        throw new Error("Invalid Git commit.");
      return { action: "commit", path: value.path };
    }
    if (value.action === "write") {
      if (Object.keys(value).some((key) => !["action", "path", "base64", "mode"].includes(key)) || typeof value.base64 !== "string") throw new Error("Invalid Git write.");
      const bytes = Buffer.from(value.base64, "base64");
      if (value.base64.length > Math.ceil(maxBytes / 3) * 4 || bytes.toString("base64") !== value.base64 || bytes.length > maxBytes) throw new Error("Expected canonical base64 up to 1 MiB.");
      if (value.mode !== undefined && (!Number.isInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o777 || ((value.mode as number) & 0o7000) !== 0)) throw new Error("Invalid POSIX mode.");
      return { action: "write", path: value.path, base64: value.base64, ...(value.mode === undefined ? {} : { mode: value.mode as number }) };
    }
    if (value.action === "rename") {
      if (Object.keys(value).some((key) => !["action", "path", "to"].includes(key)) || typeof value.to !== "string") throw new Error("Invalid Git rename.");
      pathTarget(value.to);
      if (value.path === value.to) throw new Error("Rename paths must differ.");
      return { action: "rename", path: value.path, to: value.to };
    }
    if (!["delete", "stage", "unstage"].includes(value.action) || Object.keys(value).some((key) => !["action", "path"].includes(key))) throw new Error("Unsupported Git action.");
    return { action: value.action as "delete" | "stage" | "unstage", path: value.path };
  }
  function worktree(path: string): Worktree {
    const absolute = pathTarget(path);
    let fd: number;
    try {
      const item = lstatSync(absolute);
      if (!item.isFile() || item.isSymbolicLink()) throw new Error("Only regular worktree files are supported.");
      fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = lstatSync(dirname(absolute), { bigint: true });
      return { present: false, revision: digest(["absent", path, String(parent.dev), String(parent.ino), String(parent.ctimeNs)]) };
    }
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes) || (before.mode & 0o7000n) !== 0n) throw new Error("Only single-link regular files up to 1 MiB are supported.");
      const buffer = Buffer.alloc(maxBytes + 1), count = readSync(fd, buffer, 0, buffer.length, 0), after = fstatSync(fd, { bigint: true });
      if (count > maxBytes || BigInt(count) !== before.size || before.ctimeNs !== after.ctimeNs || before.size !== after.size) throw new Error("Worktree file changed during capture.");
      const bytes = buffer.subarray(0, count).toString("base64"), mode = Number(before.mode & 0o777n), bytesDigest = createHash("sha256").update(buffer.subarray(0, count)).digest("hex");
      return { present: true, bytes, digest: bytesDigest, size: count, mode, revision: digest([bytesDigest, count, mode, String(before.dev), String(before.ino), String(before.ctimeNs)]) };
    } finally { closeSync(fd); }
  }
  function indexEntry(path: string): IndexEntry {
    const output = git(["ls-files", "--stage", "--", path]);
    if (!output) return { present: false };
    const lines = output.split("\n");
    if (lines.length !== 1) throw new Error("Unmerged index entries are unsupported.");
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t(.+)$/.exec(lines[0]!);
    if (!match || match[4] !== path || match[3] !== "0" || !oidPattern.test(match[2]!) || /^0+$/.test(match[2]!)) throw new Error("Unmerged or invalid index entry.");
    const flag = git(["ls-files", "-v", "--", path]);
    if (!flag.startsWith("H ")) throw new Error("Unsupported index entry flags.");
    if (match[1] === "160000") throw new Error("Submodules are unsupported.");
    return { present: true, mode: match[1]!, oid: match[2]!, stage: 0 };
  }
  function headEntry(path: string): IndexEntry {
    const output = git(["ls-tree", "-z", "HEAD", "--", path]);
    if (!output) return { present: false };
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]+)\t([^\0]+)\0$/.exec(output);
    if (!match || match[4] !== path || match[2] !== "blob") throw new Error("Submodules or non-files are unsupported.");
    return { present: true, mode: match[1]!, oid: match[3]!, stage: 0 };
  }
  function capture(mutation: LegacyMutation): State {
    validateRepository();
    const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!oidPattern.test(head)) throw new Error("Invalid HEAD object identity.");
    const allEntries = git(["ls-files", "--stage", "-z"]);
    const selectedPaths = mutation.action === "rename" ? [mutation.path, mutation.to] : [mutation.path];
    for (const line of allEntries.split("\0")) {
      const match = /^(\d{6}) [0-9a-f]+ [0-3]\t(.+)$/.exec(line);
      if (match?.[1] === "160000" && selectedPaths.some((path) => path === match[2] || path.startsWith(`${match[2]}/`))) throw new Error("Submodule paths are unsupported.");
      if (match?.[1] === "120000" && selectedPaths.includes(match[2]!)) throw new Error("Symlink index entries are unsupported.");
    }
    const index = indexEntry(mutation.path), selected = worktree(mutation.path);
    const destination = mutation.action === "rename" ? worktree(mutation.to) : undefined;
    const destinationIndex = mutation.action === "rename" ? indexEntry(mutation.to) : undefined;
    return { head, indexRevision: indexRevision(), worktree: selected, index, ...(destination ? { destination } : {}), ...(destinationIndex ? { destinationIndex } : {}) };
  }
  function predicted(mutation: LegacyMutation, before: State): State {
    if (mutation.action === "write") {
      const bytes = Buffer.from(mutation.base64, "base64"), mode = mutation.mode ?? (before.worktree.present ? before.worktree.mode : 0o644);
      return { ...before, worktree: { present: true, bytes: mutation.base64, digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mode, revision: "pending" } };
    }
    if (mutation.action === "delete") return { ...before, worktree: { present: false, revision: "pending" } };
    if (mutation.action === "rename") return { ...before, worktree: { present: false, revision: "pending" }, destination: before.worktree };
    if (mutation.action === "stage") {
      if (!before.worktree.present) throw new Error("Stage requires a regular worktree file.");
      const oid = git(["hash-object", "--stdin", "--no-filters"], Buffer.from(before.worktree.bytes, "base64"));
      return { ...before, index: { present: true, mode: (before.worktree.mode & 0o111) ? "100755" : "100644", oid, stage: 0 } };
    }
    return { ...before, index: headEntry(mutation.path) };
  }
  function equivalent(actual: State, expected: State) {
    const normalized = (state: State) => ({ head: state.head, index: state.index, worktree: state.worktree.present ? { present: true, bytes: state.worktree.bytes, mode: state.worktree.mode } : { present: false }, ...(state.destinationIndex ? { destinationIndex: state.destinationIndex } : {}), ...(state.destination ? { destination: state.destination.present ? { present: true, bytes: state.destination.bytes, mode: state.destination.mode } : { present: false } } : {}) });
    return same(normalized(actual), normalized(expected));
  }
  function exactForMutation(actual: State, expected: State, mutation: LegacyMutation) {
    if (mutation.action === "stage" || mutation.action === "unstage") return same(actual, expected);
    const withoutGeneration = ({ indexRevision: _ignored, ...state }: State) => state;
    return same(withoutGeneration(actual), withoutGeneration(expected));
  }
  function syncParent(path: string) {
    const fd = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  function replaceWorktree(path: string, expected: Worktree, wanted: Worktree) {
    const absolute = pathTarget(path);
    if (!same(worktree(path), expected)) throw new Error("Git worktree conflict.");
    if (!wanted.present) { if (expected.present) { unlinkSync(absolute); syncParent(absolute); } return; }
    const temporary = join(dirname(absolute), `.void-git-${randomUUID()}`), fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, Buffer.from(wanted.bytes, "base64")); fchmodSync(fd, wanted.mode); fsyncSync(fd); } finally { closeSync(fd); }
    try { const current = worktree(path); if (expected.present ? !same(current, expected) : current.present) throw new Error("Git worktree conflict."); renameSync(temporary, absolute); syncParent(absolute); } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
  function setIndex(path: string, entry: IndexEntry, expected: State, writeObject?: Worktree) {
    const lockPath = `${indexPath}.lock`, privatePath = `${indexPath}.void-${randomUUID()}`;
    let lock: number | undefined, ownedLock = false, installed = false;
    const token = Buffer.from(`void-git-lock:${randomUUID()}`);
    let lockInode: bigint | undefined;
    const original = readFileSync(indexPath);
    if (original.length > 16 * 1024 * 1024) throw new Error("Git index exceeds the managed limit.");
    const originalDigest = createHash("sha256").update(original).digest("hex");
    const manifest = readIndexState().entries;
    try {
      lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      ownedLock = true;
      writeFileSync(lock, token); fsyncSync(lock); lockInode = fstatSync(lock, { bigint: true }).ino;
      if (currentIdentity() !== identity || createHash("sha256").update(readFileSync(indexPath)).digest("hex") !== originalDigest || git(["rev-parse", "--verify", "HEAD^{commit}"]) !== expected.head || !same(readIndexState().entries, manifest) || !same(indexEntry(path), expected.index) || !same(worktree(path), expected.worktree)) throw new Error("Git index state changed before locked mutation.");
      writeFileSync(privatePath, original, { mode: 0o600, flag: "wx" });
      const privateEnv = { GIT_INDEX_FILE: privatePath };
      if (entry.present) {
        let oid = entry.oid;
        if (writeObject?.present) oid = git(["hash-object", "-w", "--stdin", "--no-filters"], Buffer.from(writeObject.bytes, "base64"));
        if (oid !== entry.oid) throw new Error("Git blob identity changed.");
        git(["update-index", "--add", "--cacheinfo", entry.mode, entry.oid, path], undefined, privateEnv);
      } else git(["update-index", "--force-remove", "--", path], undefined, privateEnv);
      const candidate = readIndexState(privatePath).entries;
      const without = (value: typeof manifest) => value.filter((item) => item.path !== path).sort((a, b) => a.path.localeCompare(b.path));
      if (!same(without(candidate), without(manifest))) throw new Error("Unrelated Git index state changed.");
      const selected = candidate.find((item) => item.path === path);
      if (entry.present ? !selected || selected.mode !== entry.mode || selected.oid !== entry.oid || (selected.flags & 0xf000) !== 0 : selected !== undefined) throw new Error("Git candidate index does not match the plan.");
      if (createHash("sha256").update(readFileSync(indexPath)).digest("hex") !== originalDigest) throw new Error("Git index changed concurrently.");
      const replacement = readFileSync(privatePath);
      ftruncateSync(lock, 0);
      let written = 0;
      while (written < replacement.length) {
        const count = writeSync(lock, replacement, written, replacement.length - written, written);
        if (count <= 0) throw new Error("Git index lock write failed.");
        written += count;
      }
      fsyncSync(lock);
      closeSync(lock);
      lock = undefined;
      renameSync(lockPath, indexPath);
      syncParent(indexPath); installed = true;
    } finally {
      if (lock !== undefined) closeSync(lock);
      try { unlinkSync(privatePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (ownedLock && !installed && !existsSync(`${privatePath}.lock`)) {
        try {
          const currentLock = lstatSync(lockPath, { bigint: true });
          const unchangedIndex = createHash("sha256").update(readFileSync(indexPath)).digest("hex") === originalDigest;
          if (currentLock.ino === lockInode && unchangedIndex && readFileSync(lockPath).equals(token)) unlinkSync(lockPath);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
  const commitLifecycle = createManagedCommitLifecycle({
    root,
    gitDir,
    commonDir,
    indexPath,
    identity,
    objectFormat,
    oidPattern,
    git,
    pathTarget,
    currentIdentity,
    validateRepository,
    rawIndex: () => readFileSync(indexPath),
    indexRevision,
  });
  const unpackCommit = (prepared: Prepared) => {
    const before = prepared.before as unknown as CommitCapture;
    const plan = prepared.plan as unknown as CommitPlan;
    if (before.kind !== "commit" || plan.kind !== "commit")
      throw new Error("Invalid managed Git commit preparation.");
    return { before, plan };
  };
  const unpack = (prepared: Prepared) => ({ before: prepared.before as unknown as Capture, plan: prepared.plan as unknown as Plan });
  const restored: RecoveryOutcome = { status: "restored", evidence: { verified: true } };
  return {
    id: "git.managed", version: "1",
    async preflight(args) {
      const mutation = parse(args);
      if (mutation.action === "commit") {
        const captured = commitLifecycle.capture(mutation);
        return { effect: "write", reversibility: "r1", readiness: "verified", scope: "Cooperative POSIX Git branch tree: one selected staged path.", resources: [`git-repository:${identity}`, `git-branch-tree:${identity}:${mutation.path}`], revision: digest(captured), blastRadius: { count: 1, precision: "exact" } };
      }
      const state = capture(mutation);
      if (["delete", "rename"].includes(mutation.action) && !state.worktree.present) throw new Error("Worktree source does not exist.");
      if (mutation.action === "rename" && state.destination?.present) throw new Error("Rename destination exists.");
      if (mutation.action === "unstage") headEntry(mutation.path);
      const isIndex = mutation.action === "stage" || mutation.action === "unstage";
      return { effect: "write", reversibility: "r1", readiness: "verified", scope: `Cooperative POSIX Git ${isIndex ? "index" : "worktree"}: one selected ${isIndex ? "index path" : mutation.action === "rename" ? "rename pair" : "path"}. No concurrent writer, commit, remote, hook, ACL, ownership or xattr guarantee.`, resources: [`git-repository:${identity}`, `${isIndex ? "git-index" : "git-worktree"}:${identity}:${mutation.path}`, ...(mutation.action === "rename" ? [`git-worktree:${identity}:${mutation.to}`] : [])], revision: digest(state), blastRadius: { count: mutation.action === "rename" ? 2 : 1, precision: "exact" } };
    },
    async prepare(args, observation, operationId) {
      const mutation = parse(args);
      if (mutation.action === "commit") {
        const captured = commitLifecycle.capture(mutation);
        if (observation.revision !== digest(captured)) throw new Error("Git state conflict.");
        return { before: captured as unknown as Json, plan: commitLifecycle.prepare(mutation, captured, operationId) as unknown as Json };
      }
      const state = capture(mutation);
      if (observation.revision !== digest(state)) throw new Error("Git state conflict.");
      const after = predicted(mutation, state);
      if (equivalent(state, after)) throw new Error("No-op Git mutations are refused.");
      return { before: { mutation, state } as unknown as Json, plan: { root, gitDir, commonDir, indexPath, objectFormat, identity, mutation, after } as unknown as Json };
    },
    async execute(args, prepared, operationId) {
      const mutation = parse(args);
      if (mutation.action === "commit") {
        const { before, plan } = unpackCommit(prepared);
        return commitLifecycle.execute(mutation, before, plan, operationId);
      }
      const { before, plan } = unpack(prepared);
      if (plan.root !== root || plan.gitDir !== gitDir || plan.commonDir !== commonDir || plan.indexPath !== indexPath || plan.objectFormat !== objectFormat || plan.identity !== identity || !same(mutation, plan.mutation) || !same(mutation, before.mutation) || !exactForMutation(capture(mutation), before.state, mutation)) throw new Error("Git capture binding or state conflict.");
      if (mutation.action === "write" || mutation.action === "delete") replaceWorktree(mutation.path, before.state.worktree, plan.after.worktree);
      else if (mutation.action === "rename") {
        if (!same(worktree(mutation.path), before.state.worktree) || !same(worktree(mutation.to), before.state.destination)) throw new Error("Git worktree conflict.");
        const source = pathTarget(mutation.path), destination = pathTarget(mutation.to);
        renameSync(source, destination); syncParent(source); if (dirname(source) !== dirname(destination)) syncParent(destination);
      } else {
        if (!same(indexEntry(mutation.path), before.state.index)) throw new Error("Git index conflict.");
        setIndex(mutation.path, plan.after.index, before.state, mutation.action === "stage" ? before.state.worktree : undefined);
      }
      const after = capture(mutation);
      if (!equivalent(after, plan.after)) throw new Error("Git mutation verification failed.");
      return { result: { action: mutation.action, path: mutation.path }, evidence: { after } as unknown as Json };
    },
    async release() {},
    async reconcile(operationId, prepared) {
      const before = prepared.before as unknown as { kind?: string };
      const plan = prepared.plan as unknown as { kind?: string };
      if (before.kind === "commit" && plan.kind === "commit") {
        const commit = unpackCommit(prepared);
        return commitLifecycle.reconcile(operationId, commit.before, commit.plan);
      }
      // State equality is not an operation-specific durable receipt and can be ABA.
      return { status: "unknown" };
    },
    async recover(prepared, outcome, recoveryId) {
      const maybeBefore = prepared.before as unknown as { kind?: string };
      const maybePlan = prepared.plan as unknown as { kind?: string };
      if (maybeBefore.kind === "commit" && maybePlan.kind === "commit") {
        const commit = unpackCommit(prepared);
        return commitLifecycle.recover(commit.before, commit.plan, outcome, recoveryId);
      }
      const { before, plan } = unpack(prepared);
      if (plan.root !== root || plan.gitDir !== gitDir || plan.commonDir !== commonDir || plan.indexPath !== indexPath || plan.objectFormat !== objectFormat || plan.identity !== identity)
        return { status: "conflict", evidence: null };
      let current: State;
      try {
        current = capture(before.mutation);
        const recorded = (outcome.evidence as { after?: State }).after;
        if (!recorded || !exactForMutation(current, recorded, before.mutation) || !equivalent(current, plan.after)) return { status: "conflict", evidence: null };
      } catch {
        return { status: "conflict", evidence: null };
      }
      const mutation = before.mutation;
      if (mutation.action === "write" || mutation.action === "delete") replaceWorktree(mutation.path, current.worktree, before.state.worktree);
      else if (mutation.action === "rename") {
        if (!current.destination?.present || current.worktree.present) return { status: "conflict", evidence: null };
        const source = pathTarget(mutation.to), destination = pathTarget(mutation.path);
        renameSync(source, destination); syncParent(source); if (dirname(source) !== dirname(destination)) syncParent(destination);
      } else setIndex(mutation.path, before.state.index, current);
      if (!equivalent(capture(mutation), before.state)) throw new Error("Git recovery verification failed.");
      return restored;
    },
    async reconcileRecovery(prepared, outcome, recoveryId) {
      const before = prepared.before as unknown as { kind?: string };
      const plan = prepared.plan as unknown as { kind?: string };
      if (before.kind === "commit" && plan.kind === "commit") {
        const commit = unpackCommit(prepared);
        return commitLifecycle.reconcileRecovery(commit.before, commit.plan, outcome, recoveryId);
      }
      // Target equality is not an operation-specific durable receipt and can be ABA.
      return { status: "unknown" };
    },
  };
}

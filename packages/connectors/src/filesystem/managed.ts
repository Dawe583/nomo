/** Cooperative workspace only: Node has no atomic compare-and-replace for paths.
 * The operator must exclude concurrent writers during dispatch and Undo. Every
 * observed edit conflicts; bytes/mode are restored, not inode, ACL or xattrs.
 */
import {
  constants,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeFileSync,
  fsyncSync,
  fchmodSync,
  renameSync,
  unlinkSync,
  linkSync,
} from "node:fs";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  Json,
  RecoveryAdapter,
  Prepared,
  Outcome,
  RecoveryContinuation,
} from "../recovery.ts";

type Mutation =
  | { action: "write"; path: string; base64: string; mode?: number }
  | { action: "delete"; path: string }
  | { action: "rename"; path: string; to: string };
type Snapshot = { bytes: string | null; mode: number; revision: string };
type Capture =
  | { path: string; snapshot: Snapshot }
  | { path: string; snapshot: Snapshot; to: string; destination: Snapshot };
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const maxBytes = 1024 * 1024;
export function managedFilesystemAdapter(options: {
  root: string;
  cooperative: true;
}): RecoveryAdapter {
  if (options.cooperative !== true)
    throw new Error("Explicit cooperative workspace ownership is required.");
  const root = realpathSync(resolve(options.root));
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory())
    throw new Error("Workspace must be a directory.");
  const identity = `${rootStat.dev}:${rootStat.ino}`;
  function target(path: string) {
    if (
      typeof path !== "string" ||
      !path ||
      path.length > 1024 ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.includes("\0")
    )
      throw new Error("Invalid workspace path.");
    const parts = path.split("/");
    if (
      parts.some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[<>:"|?*\x00-\x1f]/.test(p) ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p) ||
          /^(\.git|\.ssh|\.aws|\.env.*|\.void.*)$/i.test(p),
      )
    )
      throw new Error("Protected or invalid workspace path.");
    const current = lstatSync(root, { bigint: true });
    if (!current.isDirectory() || `${current.dev}:${current.ino}` !== identity)
      throw new Error("Workspace identity changed.");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Unsafe workspace parent.");
    }
    return join(root, path); //MUTATED
  }
  function parse(args: Json): Mutation {
    if (!args || Array.isArray(args) || typeof args !== "object")
      throw new Error("Invalid file mutation.");
    const value = args as Record<string, unknown>;
    if (typeof value.action !== "string" || typeof value.path !== "string")
      throw new Error("Invalid file mutation.");
    target(value.path);
    if (value.action === "rename") {
      if (
        Object.keys(value).some(
          (key) => !["action", "path", "to"].includes(key),
        ) ||
        typeof value.to !== "string"
      )
        throw new Error("Rename requires source and destination paths only.");
      target(value.to);
      if (process.platform === "win32")
        throw new Error("Managed rename is not verified on Windows.");
      if (value.path === value.to) throw new Error("Rename paths must differ.");
      return { action: "rename", path: value.path, to: value.to };
    }
    if (value.action === "delete") {
      if (Object.keys(value).some((key) => !["action", "path"].includes(key)))
        throw new Error("Delete accepts only a path.");
      return { action: "delete", path: value.path };
    }
    if (value.action !== "write") throw new Error("Unsupported file action.");
    if (
      Object.keys(value).some(
        (key) => !["action", "path", "base64", "mode"].includes(key),
      )
    )
      throw new Error("Invalid file mutation.");
    if (
      typeof value.base64 !== "string" ||
      value.base64.length > Math.ceil(maxBytes / 3) * 4 ||
      Buffer.from(value.base64, "base64").toString("base64") !== value.base64 ||
      Buffer.from(value.base64, "base64").length > maxBytes
    )
      throw new Error("Expected canonical base64 up to 1 MiB.");
    if (
      value.mode !== undefined &&
      (!Number.isInteger(value.mode) ||
        (value.mode as number) < 0 ||
        (value.mode as number) > 0o777)
    )
      throw new Error("Invalid file mode.");
    if (
      process.platform === "win32" &&
      value.mode !== undefined &&
      value.mode !== 0o666
    )
      throw new Error(
        "Windows managed writes support writable files (mode 0666) only.",
      );
    return {
      action: "write",
      path: value.path,
      base64: value.base64,
      ...(value.mode === undefined ? {} : { mode: value.mode as number }),
    };
  }
  function snapshot(path: string): Snapshot {
    const absolute = target(path);
    let fd: number;
    try {
      // O_NOFOLLOW is unavailable on Windows. Check the path itself as well as
      // the opened handle; cooperative ownership excludes races between them.
      const entry = lstatSync(absolute);
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("Only regular files without symlinks are supported.");
      fd = openSync(
        absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Absence is identified by the parent directory's identity, never by its
      // ctime. A directory's ctime moves when any entry in it is created or
      // removed, so folding it in made an absent file's revision depend on
      // unrelated siblings: restoring an earlier step of a recovery chain
      // invalidates the expected revision of every later step that recorded the
      // file as absent, and the chain can never finish. `replace` already
      // creates an absent target with link(2), which fails rather than
      // clobbering a file that appeared in between, so the race this was
      // watching for is covered at the write boundary instead.
      const parent = lstatSync(dirname(absolute), { bigint: true });
      return {
        bytes: null,
        mode: 0,
        revision: hash([
          "absent",
          String(parent.dev),
          String(parent.ino),
        ]),
      };
    }
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.size > BigInt(maxBytes) ||
        (stat.mode & 0o7000n) !== 0n
      )
        throw new Error(
          "Only regular, single-link files up to 1 MiB are supported.",
        );
      if (process.platform === "win32" && Number(stat.mode & 0o777n) !== 0o666)
        throw new Error(
          "Windows managed recovery requires a writable regular file.",
        );
      // Bound reads even when a non-cooperating process grows the file.
      const bytes = Buffer.alloc(maxBytes + 1);
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      if (count > maxBytes) throw new Error("File exceeded capture limit.");
      const after = fstatSync(fd, { bigint: true });
      if (
        BigInt(count) !== stat.size ||
        stat.ctimeNs !== after.ctimeNs ||
        stat.mtimeNs !== after.mtimeNs ||
        stat.size !== after.size
      )
        throw new Error("File changed during capture.");
      const encoded = bytes.subarray(0, count).toString("base64"),
        mode = Number(stat.mode & 0o777n);
      return {
        bytes: encoded,
        mode,
        revision: hash([
          encoded,
          mode,
          String(stat.dev),
          String(stat.ino),
          String(stat.ctimeNs),
          String(stat.mtimeNs),
          String(stat.uid),
          String(stat.gid),
        ]),
      };
    } finally {
      closeSync(fd);
    }
  }
  function syncDirectory(path: string) {
    // Node cannot open/flush directory handles on Windows. File contents were
    // flushed before replacement; directory-entry power-loss durability differs.
    if (process.platform === "win32") return;
    const fd = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  function replace(
    path: string,
    expected: Snapshot,
    bytes: string | null,
    mode: number,
  ) {
    const absolute = target(path);
    if (snapshot(path).revision !== expected.revision)
      throw new Error("File revision conflict.");
    if (bytes === null) {
      if (expected.bytes !== null) unlinkSync(absolute);
    } else {
      const temporary = join(dirname(absolute), `.void-${randomUUID()}`);
      const fd = openSync(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        try {
          writeFileSync(fd, Buffer.from(bytes, "base64"));
          fchmodSync(fd, mode);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        // The temp file changes the parent ctime, so absent targets use link's no-clobber guarantee.
        if (expected.bytes === null) {
          target(path);
          linkSync(temporary, absolute);
        } else {
          if (snapshot(path).revision !== expected.revision)
            throw new Error("File revision conflict.");
          renameSync(temporary, absolute);
        }
      } finally {
        try {
          unlinkSync(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    syncDirectory(absolute);
    const after = snapshot(path);
    if (after.bytes !== bytes || (bytes !== null && after.mode !== mode))
      throw new Error("File verification failed.");
    return after;
  }
  const capture = (prepared: Prepared) => prepared.before as unknown as Capture;
  async function recoverFile(
    prepared: Prepared,
    outcome: Outcome,
    expectedRevision?: string,
    expectedDestinationRevision?: string,
  ) {
    const before = capture(prepared),
      plan = prepared.plan as { root: string; identity: string };
    if (plan.root !== root || plan.identity !== identity)
      return { status: "conflict", evidence: null } as const;
    if ("to" in before) {
      const evidence = outcome.evidence as {
        sourceRevision: string;
        destinationRevision: string;
      };
      let source: Snapshot, destination: Snapshot;
      try {
        source = snapshot(before.path);
        destination = snapshot(before.to);
      } catch {
        return { status: "conflict", evidence: null } as const;
      }
      // The destination is the only endpoint a previous inverse in the same
      // job can have rewritten, so it is the only one whose expectation may
      // come from that step's receipt. The source must still carry exactly what
      // this operation left behind, or a foreign writer touched it.
      if (
        source.revision !== evidence.sourceRevision ||
        destination.revision !==
          (expectedDestinationRevision ?? evidence.destinationRevision)
      )
        return { status: "conflict", evidence: null } as const;
      renameSync(target(before.to), target(before.path));
      syncDirectory(target(before.path));
      if (dirname(target(before.path)) !== dirname(target(before.to)))
        syncDirectory(target(before.to));
      const restored = snapshot(before.path),
        removed = snapshot(before.to);
      if (
        restored.bytes !== before.snapshot.bytes ||
        restored.mode !== before.snapshot.mode ||
        removed.bytes !== null
      )
        throw new Error("File verification failed.");
      return {
        status: "restored",
        evidence: {
          path: before.path,
          from: before.to,
          revision: restored.revision,
          scope: process.platform === "win32" ? "bytes" : "bytes-and-mode",
        } as Json,
      } as const;
    }
    let current: Snapshot;
    try {
      current = snapshot(before.path);
    } catch {
      return { status: "conflict", evidence: null } as const;
    }
    const expected =
      expectedRevision ?? (outcome.evidence as { revision: string }).revision;
    if (current.revision !== expected)
      return { status: "conflict", evidence: null } as const;
    const restored = replace(
      before.path,
      current,
      before.snapshot.bytes,
      before.snapshot.mode,
    );
    return {
      status: "restored",
      evidence: {
        path: before.path,
        revision: restored.revision,
        scope: process.platform === "win32" ? "bytes" : "bytes-and-mode",
      } as Json,
    } as const;
  }
  return {
    id: "filesystem.managed",
    version: "1",
    async preflight(args) {
      const mutation = parse(args),
        before = snapshot(mutation.path),
        destination =
          mutation.action === "rename" ? snapshot(mutation.to) : undefined;
      if (
        (mutation.action === "delete" || mutation.action === "rename") &&
        before.bytes === null
      )
        throw new Error("File does not exist.");
      if (destination && destination.bytes !== null)
        throw new Error("Rename destination exists.");
      return {
        effect: "write",
        reversibility: "r1",
        readiness: "verified",
        scope:
          process.platform === "win32"
            ? `Cooperative Windows filesystem: ${mutation.action === "rename" ? "two paths" : "one writable regular file"}, bytes only. No concurrent external writer, ACL, inode, xattr, shell or directory-entry power-loss guarantee.`
            : `Cooperative filesystem: ${mutation.action === "rename" ? "two paths" : "one path"}, bytes and POSIX mode only. No concurrent external writer, inode, ACL, xattr or shell guarantee.`,
        resources: [
          `file:${join(root, mutation.path)}`,
          ...(mutation.action === "rename"
            ? [`file:${join(root, mutation.to)}`]
            : []),
        ],
        revision:
          mutation.action === "rename"
            ? hash([before.revision, destination!.revision])
            : before.revision,
        blastRadius: {
          count: mutation.action === "rename" ? 2 : 1,
          precision: "exact",
        },
        // R07: what this call consulted to decide. The before image is the
        // read, and its revision is what an undo is measured against, so a plan
        // can prove its order instead of assuming it.
        reads: [
          {
            resource: `file:${join(root, mutation.path)}`,
            revision: before.revision,
          },
          ...(mutation.action === "rename"
            ? [
                {
                  resource: `file:${join(root, mutation.to)}`,
                  revision: destination!.revision,
                },
              ]
            : []),
        ],
      };
    },
    async prepare(args, observation) {
      const mutation = parse(args),
        before = snapshot(mutation.path),
        destination =
          mutation.action === "rename" ? snapshot(mutation.to) : undefined,
        revision =
          mutation.action === "rename"
            ? hash([before.revision, destination!.revision])
            : before.revision;
      if (observation.revision !== revision)
        throw new Error("File revision conflict.");
      if (
        mutation.action === "rename" &&
        (before.bytes === null || destination!.bytes !== null)
      )
        throw new Error("File revision conflict.");
      return {
        before: (mutation.action === "rename"
          ? {
              path: mutation.path,
              snapshot: before,
              to: mutation.to,
              destination,
            }
          : { path: mutation.path, snapshot: before }) as unknown as Json,
        plan: { mutation, root, identity } as unknown as Json,
      };
    },
    async execute(args, prepared) {
      const mutation = parse(args),
        before = capture(prepared);
      const plan = prepared.plan as {
        root: string;
        identity: string;
        mutation: Json;
      };
      if (
        plan.root !== root ||
        plan.identity !== identity ||
        hash(plan.mutation) !== hash(mutation) ||
        before.path !== mutation.path
      )
        throw new Error("File capture binding mismatch.");
      if (mutation.action === "rename") {
        if (!("to" in before) || before.to !== mutation.to)
          throw new Error("File capture binding mismatch.");
        if (
          snapshot(mutation.path).revision !== before.snapshot.revision ||
          snapshot(mutation.to).revision !== before.destination.revision
        )
          throw new Error("File revision conflict.");
        renameSync(target(mutation.path), target(mutation.to));
        syncDirectory(target(mutation.path));
        if (dirname(target(mutation.path)) !== dirname(target(mutation.to)))
          syncDirectory(target(mutation.to));
        const source = snapshot(mutation.path),
          destination = snapshot(mutation.to);
        if (
          source.bytes !== null ||
          destination.bytes !== before.snapshot.bytes ||
          destination.mode !== before.snapshot.mode
        )
          throw new Error("File verification failed.");
        return {
          result: {
            path: mutation.path,
            to: mutation.to,
            action: mutation.action,
          } as Json,
          evidence: {
            sourceRevision: source.revision,
            destinationRevision: destination.revision,
          } as Json,
        };
      }
      const after = replace(
        mutation.path,
        before.snapshot,
        mutation.action === "delete" ? null : mutation.base64,
        mutation.action === "write"
          ? (mutation.mode ??
              (before.snapshot.bytes === null
                ? process.platform === "win32"
                  ? 0o666
                  : 0o644
                : before.snapshot.mode))
          : before.snapshot.mode,
      );
      return {
        result: { path: mutation.path, action: mutation.action } as Json,
        evidence: { revision: after.revision } as Json,
      };
    },
    async release() {},
    // Filesystem and journal cannot commit atomically. State equality is not a durable receipt.
    async reconcile() {
      return { status: "unknown" };
    },
    async reconcileRecovery() {
      return { status: "unknown" };
    },
    async recover(prepared, outcome) {
      return recoverFile(prepared, outcome);
    },
    async recoverWithContinuation(
      prepared,
      outcome,
      _recoveryId,
      previous: RecoveryContinuation,
    ) {
      const currentBefore = capture(prepared),
        previousBefore = capture(previous.prepared),
        currentPlan = prepared.plan as {
          root: string;
          identity: string;
          mutation: Mutation;
        },
        previousPlan = previous.prepared.plan as {
          root: string;
          identity: string;
          mutation: Mutation;
        };
      // The previous inverse can only have rewritten a path it named, and this
      // step can only be attributed to a path it also names. Their intersection
      // is the one path where a receipt from the previous step is evidence
      // about this step's starting state; anything else is a conflict rather
      // than a guess.
      const previousPaths = new Set([
        previousPlan.mutation.path,
        ...("to" in previousPlan.mutation
          ? [previousPlan.mutation.to]
          : []),
      ]);
      const currentPaths = [
        { path: currentPlan.mutation.path, endpoint: "source" as const },
        ...("to" in currentPlan.mutation
          ? [{ path: currentPlan.mutation.to, endpoint: "destination" as const }]
          : []),
      ];
      const shared = currentPaths.find((entry) =>
        previousPaths.has(entry.path),
      );
      // The revision this step's own forward execution recorded for the shared
      // endpoint is the pre-image of the previous step, which is what proves the
      // two are adjacent rather than merely both naming the same path. A rename
      // records it under the destination key; a single-path step records it as
      // `revision`.
      const forward = outcome.evidence as {
        revision?: string;
        destinationRevision?: string;
      };
      if (
        previous.recovery.status !== "restored" ||
        currentPlan.root !== root ||
        previousPlan.root !== root ||
        currentPlan.identity !== identity ||
        previousPlan.identity !== identity ||
        shared === undefined ||
        (shared.endpoint === "destination"
          ? forward.destinationRevision
          : forward.revision) !== previousBefore.snapshot.revision
      )
        return { status: "conflict", evidence: null };
      const receipt = previous.recovery.evidence as {
        path?: string;
        revision?: string;
      };
      if (receipt.path !== shared.path || typeof receipt.revision !== "string")
        return { status: "conflict", evidence: null };
      // The receipt's revision is the expected state of the endpoint both steps
      // touched. A single-path step expects it for the file it will replace; a
      // rename expects it for the destination, and its source must still carry
      // exactly what its own forward execution left behind.
      return shared.endpoint === "destination"
        ? recoverFile(prepared, outcome, undefined, receipt.revision)
        : recoverFile(prepared, outcome, receipt.revision);
    },
  };
}

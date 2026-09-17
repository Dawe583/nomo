import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { managedGitAdapter } from "../../connectors/src/git/managed.ts";
import { managedFilesystemAdapter } from "../../connectors/src/filesystem/managed.ts";
import { managedDocumentAdapter } from "../../workbench/src/managed-documents.ts";
import {
  createWorkspace,
  type WorkspaceState,
} from "../../workbench/src/workspace.ts";
import { keyProviderFromPkcs8 } from "../../ledger/src/sign.ts";
import {
  digest,
  localOperationJournal,
  reservedRecoveryVault,
  runAdapterConformance,
  CONFORMANCE_CASES,
  type ConformanceFixture,
  type Json,
} from "../../runtime/src/index.ts";

const filesystemOperations =
  process.platform === "win32"
    ? (["create", "write", "delete"] as const)
    : (["create", "write", "delete", "rename"] as const);

export const filesystemConformanceProfile = {
  schema: "void.adapter-capability.v1",
  adapter: { id: "filesystem.managed", version: "1" },
  operations: filesystemOperations,
  boundary: "cooperative-regular-file-paths",
  maxDecodedBytes: 1024 * 1024,
  recovery: { posix: "bytes-and-mode", win32: "bytes-writable-files-only" },
  durableExecutionReceipt: false,
  durableRecoveryReceipt: false,
  excluded: [
    "concurrent-external-writers",
    "git",
    "directories",
    "acl",
    "ownership",
    "xattrs",
    "shell-effects",
    "windows-directory-entry-power-loss",
    ...(process.platform === "win32" ? ["rename"] : []),
  ],
  conformance: {
    schema: "void.adapter-conformance.v1",
    fixture:
      process.platform === "win32"
        ? "disposable-local-file-create-write-delete"
        : "disposable-local-file-create-write-delete-rename",
    checks: CONFORMANCE_CASES,
  },
} as const;

export async function filesystemConformanceFixture(
  operation: "create" | "write" | "delete" | "rename" = "write",
): Promise<ConformanceFixture> {
  const dir = await mkdtemp(join(tmpdir(), "void-conformance-"));
  try {
    const root = join(dir, "project");
    await mkdir(root);
    const file = join(root, "sample.bin"),
      moved = join(root, "moved.bin");
    const original = Buffer.from([0, 255, 1, 128, 10]).toString("base64"),
      edited = Buffer.from("conformance agent edit").toString("base64"),
      humanBytes = Buffer.from("conformance human edit").toString("base64"),
      before: Json =
        operation === "create"
          ? null
          : operation === "rename"
            ? { source: original, destination: null }
            : original,
      after: Json =
        operation === "delete"
          ? null
          : operation === "rename"
            ? { source: null, destination: original }
            : edited,
      human: Json =
        operation === "rename"
          ? { source: null, destination: humanBytes }
          : humanBytes;
    if (operation !== "create")
      await writeFile(file, Buffer.from(original, "base64"));
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = keyProviderFromPkcs8(
      privateKey.export({ type: "pkcs8", format: "der" }),
    );
    const key = randomBytes(32);
    return {
      adapter: () => managedFilesystemAdapter({ root, cooperative: true }),
      options: () => ({
        journal: localOperationJournal(join(dir, "journal"), signer),
        vault: reservedRecoveryVault(
          join(dir, "vault"),
          { conformance: key },
          "conformance",
        ),
      }),
      arguments:
        operation === "rename"
          ? { action: "rename", path: "sample.bin", to: "moved.bin" }
          : after === null
            ? { action: "delete", path: "sample.bin" }
            : { action: "write", path: "sample.bin", base64: after },
      changedArguments:
        operation === "rename"
          ? { action: "rename", path: "sample.bin", to: "other.bin" }
          : { action: "write", path: "sample.bin", base64: human },
      before,
      after,
      human,
      read: async () => {
        const read = async (path: string) => {
          try {
            return (await readFile(path)).toString("base64");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        };
        return operation === "rename"
          ? { source: await read(file), destination: await read(moved) }
          : read(file);
      },
      writeHuman: () =>
        operation === "rename"
          ? writeFile(moved, Buffer.from(humanBytes, "base64"))
          : writeFile(file, Buffer.from(humanBytes, "base64")),
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}


export const gitConformanceProfile = {
  schema: "void.adapter-capability.v1",
  adapter: { id: "git.managed", version: "1" },
  operations: process.platform === "win32" ? ([] as const) : (["create", "write", "delete", "rename", "stage", "unstage"] as const),
  actionNote: "create is a write scenario against an absent path, not a public action",
  boundary: "cooperative-posix-single-git-surface",
  maxDecodedBytes: 1024 * 1024,
  recovery: { posix: "selected-worktree-bytes-mode-or-logical-index-entry", win32: "unsupported" },
  durableExecutionReceipt: false,
  durableRecoveryReceipt: false,
  certification: false,
  excluded: ["windows", "process-death", "power-loss", "concurrent-external-writers", "commits", "remotes", "hooks", "arbitrary-git", "dangling-stage-blob-removal", "acl", "ownership", "xattrs", "split-index", "non-v2-index", "unknown-index-extensions", "unsupported-index-flags"],
  conformance: {
    schema: "void.adapter-conformance.v1",
    fixture: "disposable-local-git-repository-without-remote",
    checks: CONFORMANCE_CASES,
    sharedRuntimeChecksOnly: true,
  },
} as const;

type GitScenario = (typeof gitConformanceProfile.operations)[number];
export async function gitConformanceFixture(operation: GitScenario = "write"): Promise<ConformanceFixture> {
  if (process.platform === "win32") throw new Error("git.managed is unsupported on Windows");
  const dir = await mkdtemp(join(tmpdir(), "void-git-conformance-"));
  try {
    const root = join(dir, "repo");
    execFileSync("git", ["init", "-q", root]);
    const run = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    run("config", "user.name", "VOID conformance");
    run("config", "user.email", "void@example.invalid");
    const file = join(root, "sample.bin"), moved = join(root, "moved.bin");
    const originalBuffer = Buffer.from([0, 255, 1, 128, 10]), editedBuffer = Buffer.from("conformance agent edit"), humanBuffer = Buffer.from("conformance human edit");
    await writeFile(file, originalBuffer, { mode: 0o755 });
    run("add", "sample.bin"); run("commit", "-qm", "initial");
    await writeFile(join(root, "sentinel-staged"), "base"); await writeFile(join(root, "sentinel-unstaged"), "base");
    run("add", "sentinel-staged", "sentinel-unstaged"); run("commit", "-qm", "sentinels");
    await writeFile(join(root, "sentinel-staged"), "staged human"); run("add", "sentinel-staged");
    await writeFile(join(root, "sentinel-unstaged"), "unstaged human"); await writeFile(join(root, "sentinel-untracked"), "untracked human");
    if (operation === "create") { await rm(file); run("update-index", "--force-remove", "sample.bin"); }
    if (operation === "stage" || operation === "unstage") await writeFile(file, editedBuffer, { mode: 0o755 });
    if (operation === "unstage") run("add", "sample.bin");
    const readPath = async (path: string) => { try { return (await readFile(path)).toString("base64"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } };
    const readIndex = () => run("ls-files", "--stage", "--", "sample.bin") || null;
    const readSelected = async (): Promise<Json> => operation === "rename" ? { source: await readPath(file), destination: await readPath(moved) } : operation === "stage" || operation === "unstage" ? readIndex() : readPath(file);
    const selectedBefore = await readSelected();
    const head = run("rev-parse", "HEAD"), manifestBefore = run("ls-files", "--stage").split("\n").filter(Boolean).sort();
    const rawIndex = operation === "stage" || operation === "unstage" ? null : createHash("sha256").update(await readFile(join(root, run("rev-parse", "--git-path", "index")))).digest("hex");
    const sentinel = async (name: string) => ({ bytes: await readPath(join(root, name)), mode: (await stat(join(root, name))).mode & 0o777 });
    const sentinels = async () => ({ staged: await sentinel("sentinel-staged"), unstaged: await sentinel("sentinel-unstaged"), untracked: await sentinel("sentinel-untracked") });
    const context = await sentinels();
    const arguments_: Json = operation === "rename" ? { action: "rename", path: "sample.bin", to: "moved.bin" } : operation === "delete" ? { action: "delete", path: "sample.bin" } : operation === "stage" || operation === "unstage" ? { action: operation, path: "sample.bin" } : { action: "write", path: "sample.bin", base64: editedBuffer.toString("base64"), mode: 0o644 };
    let selectedAfter: Json;
    if (operation === "rename") selectedAfter = { source: null, destination: originalBuffer.toString("base64") };
    else if (operation === "delete") selectedAfter = null;
    else if (operation === "stage") { const oid = run("hash-object", "--no-filters", "sample.bin"); selectedAfter = `100755 ${oid} 0\tsample.bin`; }
    else if (operation === "unstage") selectedAfter = run("ls-tree", "HEAD", "--", "sample.bin").replace(/^([0-9]+) blob ([0-9a-f]+)\t/, "$1 $2 0\t");
    else selectedAfter = editedBuffer.toString("base64");
    const humanOid = createHash("sha1").update(`blob ${humanBuffer.length}\0`).update(humanBuffer).digest("hex");
    const selectedHuman: Json = operation === "rename" ? { source: null, destination: humanBuffer.toString("base64") } : operation === "stage" || operation === "unstage" ? `100755 ${humanOid} 0\tsample.bin` : humanBuffer.toString("base64");
    const replaceSelected = (manifest: string[], selected: Json) => {
      const rest = manifest.filter((line) => !line.endsWith("\tsample.bin"));
      if (typeof selected === "string" && /^[0-9]{6} [0-9a-f]+ 0\t/.test(selected)) rest.push(selected);
      return rest.sort();
    };
    const before: Json = { selected: selectedBefore, head, rawIndex, index: manifestBefore, worktree: context };
    const after: Json = { selected: selectedAfter, head, rawIndex, index: operation === "stage" || operation === "unstage" ? replaceSelected(manifestBefore, selectedAfter) : manifestBefore, worktree: context };
    const human: Json = { selected: selectedHuman, head, rawIndex, index: operation === "stage" || operation === "unstage" ? replaceSelected(manifestBefore, selectedHuman) : manifestBefore, worktree: context };
    const read = async (): Promise<Json> => ({ selected: await readSelected(), head: run("rev-parse", "HEAD"), rawIndex: operation === "stage" || operation === "unstage" ? null : createHash("sha256").update(await readFile(join(root, run("rev-parse", "--git-path", "index")))).digest("hex"), index: run("ls-files", "--stage").split("\n").filter(Boolean).sort(), worktree: await sentinels() });
    const { privateKey } = generateKeyPairSync("ed25519"), signer = keyProviderFromPkcs8(privateKey.export({ type: "pkcs8", format: "der" })), key = randomBytes(32);
    return {
      adapter: () => managedGitAdapter({ root, cooperative: true }),
      options: () => ({ journal: localOperationJournal(join(dir, "journal"), signer), vault: reservedRecoveryVault(join(dir, "vault"), { conformance: key }, "conformance") }),
      arguments: arguments_,
      changedArguments: operation === "rename" ? { action: "rename", path: "sample.bin", to: "other.bin" } : operation === "stage" || operation === "unstage" ? { action: operation, path: "other.bin" } : { action: "write", path: "sample.bin", base64: humanBuffer.toString("base64") },
      before, after, human,
      read,
      writeHuman: async () => {
        if (operation === "rename") await writeFile(moved, humanBuffer);
        else if (operation === "stage" || operation === "unstage") { await writeFile(file, humanBuffer); run("add", "sample.bin"); }
        else await writeFile(file, humanBuffer);
      },
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}

export const managedDocumentsConformanceProfile = {
  schema: "void.adapter-capability.v1",
  adapter: { id: "managed-documents", version: "1" },
  operations: ["write", "delete"],
  boundary: "managed-text-documents-no-host-filesystem",
  maxDecodedBytes: 256_000,
  recovery: {
    posix: "captured-before-image-with-drift-refusal",
    win32: "captured-before-image-with-drift-refusal",
  },
  durableExecutionReceipt: false,
  durableRecoveryReceipt: false,
  certification: false,
  excluded: [
    "host-filesystem",
    "binary-documents",
    "directories",
    "concurrent-external-writers",
    "process-death",
    "power-loss",
    "remote-recovery",
  ],
  conformance: {
    schema: "void.adapter-conformance.v1",
    fixture: "disposable-in-memory-workspace",
    checks: CONFORMANCE_CASES,
    sharedRuntimeChecksOnly: true,
  },
} as const;

type ManagedDocumentsScenario = "write" | "delete";

export async function managedDocumentsConformanceFixture(
  operation: ManagedDocumentsScenario = "write",
): Promise<ConformanceFixture> {
  const dir = await mkdtemp(join(tmpdir(), "void-documents-conformance-"));
  try {
    const path = "sample.md",
      original = "conformance original document",
      edited = "conformance agent edit",
      human = "conformance human edit",
      stamp = "2026-09-18T00:00:00.000Z";
    let state: WorkspaceState = {
      ...createWorkspace(),
      files: { [path]: original },
    };
    // A changed delete targets another document: same path would be the
    // same request, and the changed request case needs a real difference.
    const inputFor = (content: string | null, other = path): Json =>
      (content === null
        ? {
            id: "operation",
            name: "void_workspace_delete",
            arguments: { path: other },
            at: stamp,
          }
        : {
            id: "operation",
            name: "void_workspace_write",
            arguments: { path: other, content },
            at: stamp,
          }) as unknown as Json;
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = keyProviderFromPkcs8(
      privateKey.export({ type: "pkcs8", format: "der" }),
    );
    const key = randomBytes(32);
    return {
      adapter: () =>
        managedDocumentAdapter({
          read: async () => state,
          // Capture binding without a ledger: the committed operation with
          // the same id must digest identically, or it is not our receipt.
          verify: async (operation) => {
            const found = state.operations.find(
              (item) => item.id === operation.id,
            );
            return !!found && digest(found) === digest(operation);
          },
          commit: async (change) => {
            state = change.state;
          },
        }),
      options: () => ({
        journal: localOperationJournal(join(dir, "journal"), signer),
        vault: reservedRecoveryVault(
          join(dir, "vault"),
          { conformance: key },
          "conformance",
        ),
      }),
      arguments: inputFor(operation === "write" ? edited : null),
      changedArguments: inputFor(
        operation === "write" ? `${human} changed` : null,
        operation === "write" ? path : "other.md",
      ),
      before: original,
      after: operation === "write" ? edited : null,
      human,
      read: async () => state.files[path] ?? null,
      writeHuman: async () => {
        state = { ...state, files: { ...state.files, [path]: human } };
      },
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function runConformanceCommand(
  argv: readonly string[],
  print: (text: string) => void,
): Promise<number> {
  const selected = argv.length === 0 ? "filesystem.managed" : argv.length === 2 && argv[0] === "--adapter" ? argv[1] : undefined;
  if (selected !== "filesystem.managed" && selected !== "git.managed" && selected !== "managed-documents")
    throw new Error("usage: void recovery conformance [--adapter filesystem.managed|git.managed|managed-documents] (disposable local fixtures only)");
  const capability = selected === "git.managed" ? gitConformanceProfile : selected === "managed-documents" ? managedDocumentsConformanceProfile : filesystemConformanceProfile;
  const scenarios = [];
  if (selected === "git.managed" && process.platform === "win32") scenarios.push({ operation: "platform-refusal", passed: false, checks: [{ id: "posix-only", passed: true }] });
  else for (const operation of capability.operations) {
    const report = await runAdapterConformance(capability.adapter, () => selected === "git.managed" ? gitConformanceFixture(operation as GitScenario) : selected === "managed-documents" ? managedDocumentsConformanceFixture(operation as ManagedDocumentsScenario) : filesystemConformanceFixture(operation as "create" | "write" | "delete" | "rename"));
    scenarios.push({ operation, ...report });
  }
  const passed = scenarios.every((report) => report.passed);
  print(
    JSON.stringify(
      {
        schema: "void.adapter-conformance-run.v1",
        passed,
        capability,
        scenarios,
      },
      null,
      2,
    ),
  );
  return passed ? 0 : 1;
}

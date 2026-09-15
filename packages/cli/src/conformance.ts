import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { managedFilesystemAdapter } from "../../connectors/src/filesystem/managed.ts";
import { keyProviderFromPkcs8 } from "../../ledger/src/sign.ts";
import {
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

export async function runConformanceCommand(
  argv: readonly string[],
  print: (text: string) => void,
): Promise<number> {
  if (
    argv.length !== 0 &&
    !(
      argv.length === 2 &&
      argv[0] === "--adapter" &&
      argv[1] === "filesystem.managed"
    )
  )
    throw new Error(
      "usage: void recovery conformance [--adapter filesystem.managed] (disposable local fixtures only)",
    );
  const scenarios = [];
  for (const operation of filesystemConformanceProfile.operations) {
    const report = await runAdapterConformance(
      filesystemConformanceProfile.adapter,
      () => filesystemConformanceFixture(operation),
    );
    scenarios.push({ operation, ...report });
  }
  const passed = scenarios.every((report) => report.passed);
  print(
    JSON.stringify(
      {
        schema: "void.adapter-conformance-run.v1",
        passed,
        capability: filesystemConformanceProfile,
        scenarios,
      },
      null,
      2,
    ),
  );
  return passed ? 0 : 1;
}

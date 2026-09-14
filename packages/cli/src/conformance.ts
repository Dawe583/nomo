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
} from "../../runtime/src/index.ts";

export const filesystemConformanceProfile = {
  schema: "void.adapter-capability.v1",
  adapter: { id: "filesystem.managed", version: "1" },
  operations: ["create", "write", "delete"],
  boundary: "cooperative-single-regular-file",
  maxDecodedBytes: 1024 * 1024,
  recovery: { posix: "bytes-and-mode", win32: "bytes-writable-files-only" },
  durableExecutionReceipt: false,
  durableRecoveryReceipt: false,
  excluded: [
    "concurrent-external-writers",
    "git",
    "rename",
    "directories",
    "acl",
    "ownership",
    "xattrs",
    "shell-effects",
    "windows-directory-entry-power-loss",
  ],
  conformance: {
    schema: "void.adapter-conformance.v1",
    fixture: "disposable-local-file-create-write-delete",
    checks: CONFORMANCE_CASES,
  },
} as const;

export async function filesystemConformanceFixture(
  operation: "create" | "write" | "delete" = "write",
): Promise<ConformanceFixture> {
  const dir = await mkdtemp(join(tmpdir(), "void-conformance-"));
  try {
    const root = join(dir, "project");
    await mkdir(root);
    const file = join(root, "sample.bin");
    const before =
      operation === "create"
        ? null
        : Buffer.from([0, 255, 1, 128, 10]).toString("base64");
    const after =
      operation === "delete"
        ? null
        : Buffer.from("conformance agent edit").toString("base64");
    const human = Buffer.from("conformance human edit").toString("base64");
    if (before !== null) await writeFile(file, Buffer.from(before, "base64"));
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
        after === null
          ? { action: "delete", path: "sample.bin" }
          : { action: "write", path: "sample.bin", base64: after },
      changedArguments: { action: "write", path: "sample.bin", base64: human },
      before,
      after,
      human,
      read: async () => {
        try {
          return (await readFile(file)).toString("base64");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      },
      writeHuman: () => writeFile(file, Buffer.from(human, "base64")),
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

import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runRecoveryCommand } from "./recovery.ts";
import { recoveryMcpServer } from "./recovery-mcp.ts";
import { managedFilesystemAdapter } from "../../connectors/src/filesystem/managed.ts";
import { retainedKeyProvider } from "../../ledger/src/sign.ts";
import { windowsKeyAcl } from "../../ledger/src/hardening.ts";
import {
  localOperationJournal,
  recoveryRuntime,
  reservedRecoveryVault,
  type JournalRecord,
  type RecoveryPlan,
} from "../../runtime/src/index.ts";

const backupTool = fileURLToPath(
  new URL("../../../scripts/src/recovery-backup.mjs", import.meta.url),
);
type BackupHistory = {
  workspace: string;
  path: string;
  entries: number;
  sequence: number;
  digest: string;
};
type BackupToolResult = {
  ok: boolean;
  manifestDigest?: string;
  history?: BackupHistory[];
  category?: string;
};
/** The tool prints one JSON object, but not necessarily on its own: node emits
 * an experimental warning for node:sqlite on stderr before it. Read the last
 * line that parses rather than assuming the whole stream is JSON. */
const toolJson = (stream: string): BackupToolResult => {
  const lines = stream.split("\n").filter((line) => line.trim() !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!) as BackupToolResult;
    } catch {
      /* Keep looking: this line is not the tool's answer. */
    }
  }
  throw new Error(`no JSON answer in tool output: ${stream.slice(0, 500)}`);
};
const runBackupTool = (args: string[]): BackupToolResult => {
  const result = spawnSync(process.execPath, [backupTool, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return toolJson(result.stdout);
};
const backupToolFailure = (args: string[]): BackupToolResult => {
  const result = spawnSync(process.execPath, [backupTool, ...args], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, result.stdout);
  return toolJson(result.stderr);
};

/** Copy a backup, then re-protect the copied signing key.
 *
 * fs.cp does not carry a Windows ACL, so a copied key arrives readable by more
 * than its owner and the ledger refuses it before the case under test ever
 * runs. These cases are about a wrong key, a truncated journal and a missing
 * artifact, so the key has to be readable by the ledger first. */
const copyBackup = async (from: string, to: string) => {
  await cp(from, to, { recursive: true });
  if (process.platform === "win32")
    await windowsKeyAcl(join(to, "state", "keys", "dev-ed25519.pkcs8"), true);
};
const planFailureCategory = async (options: {
  root: string;
  stateDir: string;
  key: Buffer;
  operationId: string;
}) => {
  const signer = await retainedKeyProvider({
    dir: join(options.stateDir, "keys"),
    env: {},
  });
  const runtime = recoveryRuntime({
    journal: localOperationJournal(join(options.stateDir, "journal"), signer),
    vault: reservedRecoveryVault(
      join(options.stateDir, "vault"),
      { local: options.key },
      "local",
    ),
    adapters: [
      managedFilesystemAdapter({ root: options.root, cooperative: true }),
    ],
    authorize: async () => true,
  });
  const server = recoveryMcpServer({
    runtime,
    workspace: "backup-test",
    agentId: "agent",
    adapterId: "filesystem.managed",
    permitted: async () => true,
  });
  const client = new Client({ name: "backup-restore-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(clientTransport);
  await client.connect(serverTransport);
  try {
    const result = await client.callTool({
      name: "nomo_recovery_plan",
      arguments: { operationId: options.operationId },
    });
    const content = result.content;
    if (!Array.isArray(content) || typeof content[0]?.text !== "string")
      throw new Error("MCP error content unavailable.");
    return JSON.parse(content[0].text) as { category: string; message: string };
  } finally {
    await client.close();
    await server.close();
  }
};
test("filesystem CLI restores in place but a copied old-operation workspace fails closed as conflict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-fs-cli-"));
  const env = { TEST_KEY: randomBytes(32).toString("base64") };
  try {
    await mkdir(join(dir, "project"));
    await writeFile(join(dir, "project", "notes.md"), "User original");
    const config = join(dir, "config.json"),
      input = join(dir, "input.json");
    await writeFile(
      config,
      JSON.stringify({
        workspace: "test",
        stateDir: "state",
        encryptionKeyEnv: "TEST_KEY",
        filesystem: { root: "project", cooperative: true },
      }),
    );
    await writeFile(
      input,
      JSON.stringify({
        workspace: "test",
        operationId: "op",
        runId: "run",
        agentId: "agent",
        adapterId: "filesystem.managed",
        arguments: {
          action: "write",
          path: "notes.md",
          base64: Buffer.from("Agent edit").toString("base64"),
        },
      }),
    );
    let inspected: { approvalDigest: string } | undefined;
    assert.equal(
      await runRecoveryCommand(
        ["inspect", "--config", config, "--input", input],
        env,
        (s) => (inspected = JSON.parse(s)),
      ),
      0,
    );
    assert.equal(
      await runRecoveryCommand(
        [
          "execute",
          "--config",
          config,
          "--input",
          input,
          "--approve",
          inspected!.approvalDigest,
        ],
        env,
        () => {},
      ),
      0,
    );
    assert.equal(
      await readFile(join(dir, "project", "notes.md"), "utf8"),
      "Agent edit",
    );
    const signingKeyPath = join(dir, "state", "keys", "dev-ed25519.pkcs8");
    const originalSigningKey = await readFile(signingKeyPath);
    await rm(signingKeyPath);
    try {
      await assert.rejects(
        runRecoveryCommand(["plan", "--config", config, "--input", input], env, () => {}),
        /retained recovery signing key is unavailable/i,
      );
      await assert.rejects(readFile(signingKeyPath), { code: "ENOENT" });
      assert.equal(await readFile(join(dir, "project", "notes.md"), "utf8"), "Agent edit");
    } finally {
      // Restoring the key recreates the file, and a fresh file on Windows gets
      // the directory's ACL rather than the owner-only one the ledger demands.
      await writeFile(signingKeyPath, originalSigningKey, { mode: 0o600 });
      if (process.platform === "win32") await windowsKeyAcl(signingKeyPath, true);
    }
    const restoredDir = join(dir, "isolated-restore");
    await mkdir(restoredDir);
    await cp(join(dir, "project"), join(restoredDir, "project"), {
      recursive: true,
    });
    await cp(join(dir, "state"), join(restoredDir, "state"), {
      recursive: true,
    });
    // fs.cp does not carry a Windows ACL, so the copied dev key arrives with
    // the destination's broader ACL and the ledger correctly refuses it. An
    // operator restoring retained state re-protects the key, which is what the
    // recovery contract already says happens to it. Without this the copy would
    // fail on the key rather than on the path conflict this case is about.
    if (process.platform === "win32") {
      await windowsKeyAcl(
        join(restoredDir, "state", "keys", "dev-ed25519.pkcs8"),
        true,
      );
    }
    await cp(config, join(restoredDir, "config.json"));
    await cp(input, join(restoredDir, "input.json"));
    const restoredConfig = join(restoredDir, "config.json");
    const restoredInput = join(restoredDir, "input.json");
    let restoredPlan: RecoveryPlan | undefined;
    assert.equal(
      await runRecoveryCommand(
        ["plan", "--config", restoredConfig, "--input", restoredInput],
        env,
        (text) => {
          restoredPlan = JSON.parse(text) as RecoveryPlan;
        },
      ),
      0,
    );
    await writeFile(restoredInput, JSON.stringify(restoredPlan));
    let restoredOutcome: unknown;
    assert.equal(
      await runRecoveryCommand(
        [
          "apply",
          "--config",
          restoredConfig,
          "--input",
          restoredInput,
          "--approve",
          restoredPlan!.digest,
        ],
        env,
        (text) => {
          restoredOutcome = JSON.parse(text) as unknown;
        },
      ),
      1,
    );
    assert.deepEqual(restoredOutcome, { status: "conflict", evidence: null });
    assert.equal(
      await readFile(join(restoredDir, "project", "notes.md"), "utf8"),
      "Agent edit",
    );
    assert.equal(
      await readFile(join(dir, "project", "notes.md"), "utf8"),
      "Agent edit",
    );
    let plan: RecoveryPlan | undefined;
    assert.equal(
      await runRecoveryCommand(
        ["plan", "--config", config, "--input", input],
        env,
        (s) => (plan = JSON.parse(s)),
      ),
      0,
    );
    await writeFile(input, JSON.stringify(plan));
    assert.equal(
      await runRecoveryCommand(
        [
          "apply",
          "--config",
          config,
          "--input",
          input,
          "--approve",
          plan!.digest,
        ],
        env,
        () => {},
      ),
      0,
    );
    assert.equal(
      await readFile(join(dir, "project", "notes.md"), "utf8"),
      "User original",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("complete stopped-executor backup includes WAL state and restores a retained operation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-complete-backup-"));
  const key = randomBytes(32);
  const wrongKey = randomBytes(32);
  const env = { TEST_KEY: key.toString("base64") };
  const projectRoot = join(dir, "project");
  const stateDir = join(dir, "state");
  const config = join(dir, "config.json");
  const input = join(dir, "input.json");
  let reader: DatabaseSync | undefined;
  try {
    await mkdir(projectRoot);
    await writeFile(join(projectRoot, "notes.md"), "User original");
    const recoveryConfig = {
      workspace: "backup-test",
      stateDir: "state",
      encryptionKeyEnv: "TEST_KEY",
      filesystem: { root: "project", cooperative: true as const },
    };
    await writeFile(config, JSON.stringify(recoveryConfig));
    await writeFile(
      input,
      JSON.stringify({
        workspace: "backup-test",
        operationId: "backup-op",
        runId: "backup-run",
        agentId: "agent",
        adapterId: "filesystem.managed",
        arguments: {
          action: "write",
          path: "notes.md",
          base64: Buffer.from("Agent edit").toString("base64"),
        },
      }),
    );
    let inspected: { approvalDigest: string } | undefined;
    assert.equal(
      await runRecoveryCommand(
        ["inspect", "--config", config, "--input", input],
        env,
        (text) => {
          inspected = JSON.parse(text) as { approvalDigest: string };
        },
      ),
      0,
    );
    assert.equal(
      await runRecoveryCommand(
        [
          "execute",
          "--config",
          config,
          "--input",
          input,
          "--approve",
          inspected!.approvalDigest,
        ],
        env,
        () => {},
      ),
      0,
    );
    assert.equal(
      await readFile(join(projectRoot, "notes.md"), "utf8"),
      "Agent edit",
    );

    const sourceVault = join(stateDir, "vault", "vault.sqlite");
    const writer = new DatabaseSync(sourceVault);
    writer.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE backup_probe(value TEXT NOT NULL);",
    );
    writer.prepare("INSERT INTO backup_probe VALUES(?)").run("checkpointed");
    reader = new DatabaseSync(sourceVault, { readOnly: true });
    reader.prepare("SELECT count(*) AS count FROM backup_probe").get();
    writer.prepare("INSERT INTO backup_probe VALUES(?)").run("wal-only");
    writer.close();
    assert.ok((await stat(`${sourceVault}-wal`)).size > 0);

    const mainOnly = join(dir, "main-only.sqlite");
    await copyFile(sourceVault, mainOnly);
    const mainOnlyDatabase = new DatabaseSync(mainOnly, { readOnly: true });
    let mainOnlyRows = 0;
    try {
      mainOnlyRows = Number(
        mainOnlyDatabase
          .prepare("SELECT count(*) AS count FROM backup_probe")
          .get()?.count,
      );
    } catch {
      mainOnlyRows = 0;
    } finally {
      mainOnlyDatabase.close();
    }
    assert.ok(mainOnlyRows < 2, "the raw main file must not stand in for WAL");

    const backupDir = join(dir, "complete-backup");
    const created = runBackupTool([
      "create",
      "--state",
      stateDir,
      "--backup",
      backupDir,
      "--encryption-key-env",
      "TEST_KEY",
      "--executor-stopped",
    ]);
    assert.equal(created.ok, true);
    assert.match(created.manifestDigest!, /^[a-f0-9]{64}$/);
    assert.equal(created.history?.length, 1);
    assert.equal(created.history[0]?.workspace, "backup-test");
    assert.equal(created.history[0]?.sequence, 5);
    const manifestText = await readFile(
      join(backupDir, "recovery-backup-manifest.json"),
      "utf8",
    );
    assert.equal(manifestText.includes(env.TEST_KEY), false);
    assert.equal(manifestText.includes(wrongKey.toString("base64")), false);
    assert.match(manifestText, /"encryptionKeyEnv": "TEST_KEY"/);

    const backedUpDatabase = new DatabaseSync(
      join(backupDir, "state", "vault", "vault.sqlite"),
      { readOnly: true },
    );
    try {
      assert.equal(
        Number(
          backedUpDatabase
            .prepare("SELECT count(*) AS count FROM backup_probe")
            .get()?.count,
        ),
        2,
      );
      assert.ok(
        Number(
          backedUpDatabase
            .prepare("SELECT count(*) AS count FROM artifacts")
            .get()?.count,
        ) > 0,
      );
    } finally {
      backedUpDatabase.close();
    }
    assert.deepEqual(
      runBackupTool([
        "verify",
        "--backup",
        backupDir,
        "--anchor",
        created.manifestDigest!,
      ]),
      {
        ok: true,
        manifestDigest: created.manifestDigest,
        history: created.history,
      },
    );
    const repeated = runBackupTool([
      "create",
      "--state",
      stateDir,
      "--backup",
      join(dir, "complete-backup-repeat"),
      "--encryption-key-env",
      "TEST_KEY",
      "--executor-stopped",
    ]);
    assert.equal(repeated.manifestDigest, created.manifestDigest);
    assert.deepEqual(repeated.history, created.history);
    reader.close();
    reader = undefined;

    const originalSigner = await retainedKeyProvider({
      dir: join(stateDir, "keys"),
      env: {},
    });
    let originalHead: JournalRecord | undefined;
    await localOperationJournal(
      join(stateDir, "journal"),
      originalSigner,
    ).transaction("backup-test", async (transaction) => {
      originalHead = transaction.records?.at(-1);
    });
    assert.equal(originalHead?.sequence, created.history?.[0]?.sequence);
    assert.equal(
      (originalHead?.event as { stage?: string } | undefined)?.stage,
      "succeeded",
    );

    const wrongKeyBackup = join(dir, "wrong-key-backup");
    await copyBackup(backupDir, wrongKeyBackup);
    const wrongKeyFailure = await planFailureCategory({
      root: projectRoot,
      stateDir: join(wrongKeyBackup, "state"),
      key: wrongKey,
      operationId: "backup-op",
    });
    assert.deepEqual(wrongKeyFailure, {
      category: "key_unavailable",
      message: "The retained recovery key is unavailable. Restore the original key before retrying.",
    });
    assert.equal(
      JSON.stringify(wrongKeyFailure).includes(wrongKey.toString("base64")),
      false,
    );
    assert.equal(
      await readFile(join(projectRoot, "notes.md"), "utf8"),
      "Agent edit",
    );

    const missingArtifactBackup = join(dir, "missing-artifact-backup");
    await copyBackup(backupDir, missingArtifactBackup);
    const incompleteVault = new DatabaseSync(
      join(missingArtifactBackup, "state", "vault", "vault.sqlite"),
    );
    try {
      incompleteVault
        .prepare(
          "DELETE FROM artifacts WHERE workspace=? AND operation_id=? AND slot=?",
        )
        .run("backup-test", "backup-op", "capture");
    } finally {
      incompleteVault.close();
    }
    const missingArtifactFailure = await planFailureCategory({
      root: projectRoot,
      stateDir: join(missingArtifactBackup, "state"),
      key,
      operationId: "backup-op",
    });
    assert.deepEqual(missingArtifactFailure, {
      category: "missing_artifact",
      message:
        "Required recovery evidence is unavailable. Restore the retained state before retrying.",
    });
    assert.equal(
      await readFile(join(projectRoot, "notes.md"), "utf8"),
      "Agent edit",
    );

    assert.deepEqual(
      backupToolFailure(["verify", "--backup", backupDir]),
      { ok: false, category: "history_unanchored" },
    );
    const truncatedBackup = join(dir, "truncated-backup");
    await copyBackup(backupDir, truncatedBackup);
    const journalPath = join(
      truncatedBackup,
      "state",
      "journal",
      "backup-test.jsonl",
    );
    const journalLines = (await readFile(journalPath, "utf8"))
      .split("\n")
      .filter(Boolean);
    assert.equal(journalLines.length, 5);
    await writeFile(journalPath, `${journalLines.slice(0, -1).join("\n")}\n`);
    assert.deepEqual(
      backupToolFailure([
        "verify",
        "--backup",
        truncatedBackup,
        "--anchor",
        created.manifestDigest!,
      ]),
      { ok: false, category: "history_incomplete" },
    );

    await rm(stateDir, { recursive: true });
    await cp(join(backupDir, "state"), stateDir, { recursive: true });
    // This is the restore path the tool exists for, and the copy drops the
    // Windows ACL, so the operator restoring retained state re-protects the key
    // exactly as recovery-backup.mjs does on the way in.
    if (process.platform === "win32")
      await windowsKeyAcl(join(stateDir, "keys", "dev-ed25519.pkcs8"), true);
    const restoredSigner = await retainedKeyProvider({
      dir: join(stateDir, "keys"),
      env: {},
    });
    let restoredHead: JournalRecord | undefined;
    await localOperationJournal(
      join(stateDir, "journal"),
      restoredSigner,
    ).transaction("backup-test", async (transaction) => {
      restoredHead = transaction.records?.at(-1);
    });
    assert.equal(restoredHead?.sequence, originalHead?.sequence);
    assert.equal(restoredHead?.digest, originalHead?.digest);

    let restoredPlan: RecoveryPlan | undefined;
    assert.equal(
      await runRecoveryCommand(
        ["plan", "--config", config, "--input", input],
        env,
        (text) => {
          restoredPlan = JSON.parse(text) as RecoveryPlan;
        },
      ),
      0,
    );
    await writeFile(input, JSON.stringify(restoredPlan));
    let restoredOutcome:
      | {
          status: string;
          evidence?: { path: string; revision: string; scope: string };
        }
      | undefined;
    assert.equal(
      await runRecoveryCommand(
        [
          "apply",
          "--config",
          config,
          "--input",
          input,
          "--approve",
          restoredPlan!.digest,
        ],
        env,
        (text) => {
          restoredOutcome = JSON.parse(text) as typeof restoredOutcome;
        },
      ),
      0,
    );
    assert.equal(restoredOutcome?.status, "restored");
    assert.equal(restoredOutcome?.evidence?.path, "notes.md");
    assert.equal(
      restoredOutcome?.evidence?.scope,
      process.platform === "win32" ? "bytes" : "bytes-and-mode",
    );
    assert.match(restoredOutcome!.evidence!.revision, /^[a-f0-9]{64}$/);
    assert.equal(
      await readFile(join(projectRoot, "notes.md"), "utf8"),
      "User original",
    );
  } finally {
    reader?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "filesystem CLI inspects, renames and restores a binary file",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "nomo-fs-rename-cli-"));
    const env = { TEST_KEY: randomBytes(32).toString("base64") };
    try {
      await mkdir(join(dir, "project"));
      const bytes = randomBytes(2048);
      await writeFile(join(dir, "project", "source.bin"), bytes);
      const config = join(dir, "config.json"),
        input = join(dir, "input.json");
      await writeFile(
        config,
        JSON.stringify({
          workspace: "test",
          stateDir: "state",
          encryptionKeyEnv: "TEST_KEY",
          filesystem: { root: "project", cooperative: true },
        }),
      );
      await writeFile(
        input,
        JSON.stringify({
          workspace: "test",
          operationId: "rename",
          runId: "run",
          agentId: "agent",
          adapterId: "filesystem.managed",
          arguments: { action: "rename", path: "source.bin", to: "moved.bin" },
        }),
      );
      let inspected: { approvalDigest: string } | undefined;
      assert.equal(
        await runRecoveryCommand(
          ["inspect", "--config", config, "--input", input],
          env,
          (text) => (inspected = JSON.parse(text)),
        ),
        0,
      );
      assert.equal(
        await runRecoveryCommand(
          [
            "execute",
            "--config",
            config,
            "--input",
            input,
            "--approve",
            inspected!.approvalDigest,
          ],
          env,
          () => {},
        ),
        0,
      );
      assert.deepEqual(
        await readFile(join(dir, "project", "moved.bin")),
        bytes,
      );
      let plan: RecoveryPlan | undefined;
      assert.equal(
        await runRecoveryCommand(
          ["plan", "--config", config, "--input", input],
          env,
          (text) => (plan = JSON.parse(text)),
        ),
        0,
      );
      await writeFile(input, JSON.stringify(plan));
      assert.equal(
        await runRecoveryCommand(
          [
            "apply",
            "--config",
            config,
            "--input",
            input,
            "--approve",
            plan!.digest,
          ],
          env,
          () => {},
        ),
        0,
      );
      assert.deepEqual(
        await readFile(join(dir, "project", "source.bin")),
        bytes,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

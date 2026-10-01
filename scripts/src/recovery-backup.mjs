#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { retainedKeyProvider } from "../../packages/ledger/src/sign.ts";
import {
  assertPrivateFilePath,
  auditPrivateTree,
  ensurePrivateDirectory,
  ensurePrivateFile,
  readPrivateFile,
  windowsKeyAcl,
} from "../../packages/ledger/src/hardening.ts";
import { jsonlStore } from "../../packages/ledger/src/store.ts";

const manifestName = "recovery-backup-manifest.json";
const digestPattern = /^[a-f0-9]{64}$/;
const categories = {
  backup_incomplete: "Backup inventory is incomplete.",
  history_incomplete: "Signed history does not match the backup anchor.",
  history_invalid: "Signed history verification failed.",
  history_unanchored: "A trusted backup manifest anchor is required.",
  invalid_arguments: "Backup arguments are invalid.",
  key_unavailable: "The retained signing key is unavailable.",
  missing_artifact: "Required recovery evidence is unavailable.",
  vault_unverifiable: "The vault snapshot could not be verified.",
};

class RecoveryBackupError extends Error {
  constructor(category) {
    super(categories[category]);
    this.category = category;
  }
}

const refuse = (category) => {
  throw new RecoveryBackupError(category);
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fileDigest(path) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}
const portable = (path) => path.split(sep).join("/");

async function regularFile(path, category = "backup_incomplete") {
  const stat = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") refuse(category);
    throw error;
  });
  if (!stat.isFile()) refuse(category);
  await assertPrivateFilePath(path, "recovery backup file").catch(() =>
    refuse(category),
  );
  return stat;
}

const ephemeralStatePath = (path) =>
  /^vault\/vault\.sqlite-(?:wal|shm|journal)$/.test(path) ||
  /^journal\/\.writer\.sqlite(?:-.*)?$/.test(path);
async function inventory(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = portable(relative(root, path));
      if (ephemeralStatePath(relativePath)) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        files.push({
          path: relativePath,
          ...(await fileDigest(path)),
        });
      else refuse("backup_incomplete");
    }
  }
  await visit(root);
  return files.sort((left, right) => (left.path < right.path ? -1 : 1));
}

async function history(stateRoot) {
  const journalRoot = join(stateRoot, "journal");
  const signer = await retainedKeyProvider({
    dir: join(stateRoot, "keys"),
    env: {},
  });
  const store = jsonlStore(signer, { dir: journalRoot });
  const names = (await readdir(journalRoot))
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  if (names.length === 0) refuse("history_incomplete");
  const anchored = [];
  for (const name of names) {
    const workspace = basename(name, ".jsonl");
    let verification;
    try {
      verification = await store.verify(workspace);
    } catch {
      refuse("history_invalid");
    }
    if (!verification.ok) refuse("history_invalid");
    const records = [];
    for await (const record of store.read(workspace)) records.push(record);
    const head = records.at(-1);
    if (!head || head.seq !== records.length) refuse("history_incomplete");
    anchored.push({
      workspace,
      path: `journal/${name}`,
      entries: records.length,
      sequence: head.seq,
      digest: head.hash,
    });
  }
  return anchored;
}

async function createBackup({ stateDir, backupDir, encryptionKeyEnv }) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(encryptionKeyEnv))
    refuse("invalid_arguments");
  const source = resolve(stateDir);
  const destination = resolve(backupDir);
  if (destination === source || destination.startsWith(`${source}${sep}`))
    refuse("invalid_arguments");
  const sourceStat = await lstat(source).catch((error) => {
    if (error.code === "ENOENT") refuse("backup_incomplete");
    throw error;
  });
  if (!sourceStat.isDirectory()) refuse("backup_incomplete");
  const sourceAudit = await auditPrivateTree(source);
  if (sourceAudit.state !== "private") refuse("backup_incomplete");
  await lstat(destination).then(
    () => refuse("invalid_arguments"),
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await ensurePrivateDirectory(destination, "recovery backup destination");
  const stateCopy = join(destination, "state");
  try {
    await ensurePrivateDirectory(stateCopy, "recovery backup state directory");
    await cp(source, stateCopy, {
      recursive: true,
      filter(path) {
        const name = portable(relative(source, path));
        return (
          name === "" ||
          (name !== "vault/vault.sqlite" &&
            !name.startsWith("vault/vault.sqlite-") &&
            name !== "journal/.writer.sqlite" &&
            !name.startsWith("journal/.writer.sqlite-"))
        );
      },
    });
    const signingKey = join(stateCopy, "keys", "dev-ed25519.pkcs8");
    await regularFile(signingKey, "key_unavailable");
    // The destination tree is private before copying starts. The following
    // path ACL check confirms fs.cp inherited that protected boundary.
    if (process.platform === "win32") await windowsKeyAcl(signingKey, true);

    const sourceVault = join(source, "vault", "vault.sqlite");
    const restoredVault = join(stateCopy, "vault", "vault.sqlite");
    await regularFile(sourceVault, "missing_artifact");
    await ensurePrivateDirectory(dirname(restoredVault), "recovery backup vault directory");
    await ensurePrivateFile(restoredVault, "recovery backup vault database");
    const database = new DatabaseSync(sourceVault, { readOnly: true });
    try {
      // SQLite's online backup API copies the source snapshot through SQLite,
      // including committed WAL pages. A concurrent external write restarts the
      // backup, so the command requires the executor to be stopped first.
      // Sources: https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options
      // https://www.sqlite.org/backup.html
      await backup(database, restoredVault, { rate: 256 });
    } finally {
      database.close();
    }
    await assertPrivateFilePath(restoredVault, "recovery backup vault database");

    const manifest = {
      schema: "void.recovery-backup.v1",
      encryptionKeyEnv,
      files: await inventory(stateCopy),
      history: await history(stateCopy),
    };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(destination, manifestName), bytes, { mode: 0o600 });
    const backupAudit = await auditPrivateTree(destination);
    if (backupAudit.state !== "private") refuse("backup_incomplete");
    return {
      ok: true,
      manifestDigest: sha256(bytes),
      history: manifest.history,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function verifyBackup({ backupDir, anchor }) {
  if (!anchor || !digestPattern.test(anchor)) refuse("history_unanchored");
  const destination = resolve(backupDir);
  const destinationAudit = await auditPrivateTree(destination);
  if (destinationAudit.state !== "private") refuse("backup_incomplete");
  let bytes;
  try {
    bytes = await readPrivateFile(
      join(destination, manifestName),
      "recovery backup manifest",
    );
  } catch {
    refuse("history_unanchored");
  }
  if (sha256(bytes) !== anchor) refuse("history_unanchored");
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse("history_unanchored");
  }
  if (
    manifest?.schema !== "void.recovery-backup.v1" ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(manifest.encryptionKeyEnv) ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.history)
  )
    refuse("history_unanchored");

  const stateCopy = join(destination, "state");
  const actualFiles = await inventory(stateCopy).catch((error) => {
    if (error instanceof RecoveryBackupError) throw error;
    refuse("backup_incomplete");
  });
  const expectedFiles = new Map(
    manifest.files.map((file) => [file.path, file]),
  );
  const actualPaths = new Set(actualFiles.map((file) => file.path));
  for (const expected of manifest.files) {
    if (!actualPaths.has(expected.path)) {
      if (expected.path.startsWith("keys/")) refuse("key_unavailable");
      if (expected.path.startsWith("journal/")) refuse("history_incomplete");
      if (expected.path.startsWith("vault/")) refuse("missing_artifact");
      refuse("backup_incomplete");
    }
  }
  for (const actual of actualFiles) {
    const expected = expectedFiles.get(actual.path);
    if (!expected) refuse("backup_incomplete");
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      if (actual.path.startsWith("keys/")) refuse("key_unavailable");
      if (actual.path.startsWith("journal/")) refuse("history_incomplete");
      if (actual.path.startsWith("vault/")) refuse("vault_unverifiable");
      refuse("backup_incomplete");
    }
  }

  const actualHistory = await history(stateCopy);
  if (JSON.stringify(actualHistory) !== JSON.stringify(manifest.history))
    refuse("history_incomplete");
  return {
    ok: true,
    manifestDigest: anchor,
    history: actualHistory,
  };
}

function argumentsFor(command) {
  const allowed = new Set(
    command === "create"
      ? ["--state", "--backup", "--encryption-key-env", "--executor-stopped"]
      : ["--backup", "--anchor"],
  );
  const result = {};
  const argv = process.argv.slice(3);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!allowed.has(option)) refuse("invalid_arguments");
    if (option === "--executor-stopped") result.executorStopped = true;
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) refuse("invalid_arguments");
      result[option.slice(2)] = value;
      index += 1;
    }
  }
  return result;
}

async function main() {
  const command = process.argv[2];
  let result;
  if (command === "create") {
    const args = argumentsFor(command);
    if (!args.executorStopped) refuse("invalid_arguments");
    result = await createBackup({
      stateDir: args.state,
      backupDir: args.backup,
      encryptionKeyEnv: args["encryption-key-env"],
    });
  } else if (command === "verify") {
    const args = argumentsFor(command);
    result = await verifyBackup({ backupDir: args.backup, anchor: args.anchor });
  } else refuse("invalid_arguments");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const category =
    error instanceof RecoveryBackupError ? error.category : "backup_incomplete";
  // The generic fallback above discards the real cause, so a plain fs error was
  // indistinguishable from a refused inventory. The category stays the machine
  // readable contract; the reason is what an operator or a test can act on.
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      category,
      ...(error instanceof RecoveryBackupError
        ? {}
        : { reason: String(error?.message ?? error).slice(0, 500) }),
    })}\n`,
  );
  process.exitCode = 1;
});

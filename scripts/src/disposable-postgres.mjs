#!/usr/bin/env node
// Starts an isolated loopback PostgreSQL cluster only for one child command.
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startLocalPostgresWsproxy } from "./local-postgres-wsproxy.mjs";

const HOST = "127.0.0.1";
const PORT = 5432;
const USER = "void_test";
const DATABASE = "void_gui_upgrade_preview";

export function disposablePostgresUrl(password) {
  return `postgresql://${USER}:${encodeURIComponent(password)}@${HOST}:${PORT}/${DATABASE}`;
}

export function parseDisposablePostgresInvocation(argv) {
  const operands = argv[0] === "--" ? argv.slice(1) : argv;
  if (operands.length === 0)
    throw new Error(
      "usage: node scripts/src/disposable-postgres.mjs [--] <command> [args...]",
    );
  return { command: operands[0], args: operands.slice(1) };
}

export function redactDisposablePostgresSecrets(output, { url, password }) {
  let redacted = output;
  for (const secret of [url, password])
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  return redacted;
}

function loopbackPortFree() {
  return new Promise((resolvePromise) => {
    const probe = net.createServer();
    probe.once("error", () => resolvePromise(false));
    probe.once("listening", () => {
      probe.close(() => resolvePromise(true));
    });
    probe.listen(PORT, HOST);
  });
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed during disposable PostgreSQL setup.\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  return result;
}

function runChild(command, args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let force;
    const forward = (signal) => () => {
      child.kill(signal);
      clearTimeout(force);
      force = setTimeout(() => child.kill("SIGKILL"), 5000);
    };
    const sigint = forward("SIGINT");
    const sigterm = forward("SIGTERM");
    process.once("SIGINT", sigint);
    process.once("SIGTERM", sigterm);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
    });
    child.on("close", (status, signal) => {
      clearTimeout(force);
      process.removeListener("SIGINT", sigint);
      process.removeListener("SIGTERM", sigterm);
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

async function main() {
  let invocation;
  try {
    invocation = parseDisposablePostgresInvocation(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  if (!(await loopbackPortFree()))
    throw new Error(
      `refusing to start disposable PostgreSQL: ${HOST}:${PORT} is already in use`,
    );
  for (const binary of ["initdb", "pg_ctl", "createdb"])
    runChecked(binary, ["--version"]);

  const root = await mkdtemp(join(tmpdir(), "nomo-disposable-postgres-"));
  const data = join(root, "data");
  const socket = join(root, "socket");
  const log = join(root, "postgres.log");
  const passwordFile = join(root, "password");
  const password = randomBytes(24).toString("base64url");
  const url = disposablePostgresUrl(password);
  let started = false;
  let proxy;
  try {
    await mkdir(socket);
    await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
    runChecked("initdb", [
      "-D",
      data,
      "-U",
      USER,
      "--auth=scram-sha-256",
      "--pwfile",
      passwordFile,
    ]);
    await rm(passwordFile, { force: true });
    runChecked("pg_ctl", [
      "-D",
      data,
      "-l",
      log,
      "-o",
      `-h ${HOST}`,
      "-o",
      `-p ${PORT}`,
      "-o",
      `-k ${socket}`,
      "-w",
      "-t",
      "30",
      "start",
    ]);
    started = true;
    runChecked(
      "createdb",
      ["-h", HOST, "-p", String(PORT), "-U", USER, DATABASE],
      { env: { ...process.env, PGPASSWORD: password } },
    );
    proxy = await startLocalPostgresWsproxy();
    const result = await runChild(invocation.command, invocation.args, {
      ...process.env,
      NOMO_TEST_DATABASE_ISOLATED: "1",
      NOMO_RECOVERY_DATABASE_TEST: "1",
      NOMO_TEST_DATABASE_URL: url,
      NOMO_TEST_WS_PROXY: `127.0.0.1:${proxy.port}/v1`,
      DATABASE_URL: url,
    });
    process.stdout.write(
      redactDisposablePostgresSecrets(result.stdout, { url, password }),
    );
    process.stderr.write(
      redactDisposablePostgresSecrets(result.stderr, { url, password }),
    );
    process.exitCode = result.status ?? 1;
  } finally {
    if (proxy) await proxy.close();
    if (started)
      spawnSync(
        "pg_ctl",
        ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"],
        { stdio: "ignore" },
      );
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`disposable postgres: ${error.message}`);
    process.exitCode = 1;
  });
}

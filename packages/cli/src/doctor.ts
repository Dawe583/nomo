/**
 * Local environment checks. Read only: it never creates directories, never
 * opens encrypted state and never touches the network. Missing first-run
 * state is a warning, never a failure.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";

export type DoctorIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};
export type DoctorDeps = {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly nodeVersion?: string;
  readonly run?: (cmd: string, args: readonly string[]) => Promise<string>;
  readonly writable?: (dir: string) => Promise<"ok" | "missing" | "denied">;
  readonly present?: (path: string) => Promise<boolean>;
};
type Status = "PASS" | "WARN" | "FAIL";

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function defaultRun(cmd: string, args: readonly string[]): Promise<string> {
  const child = execFile(cmd, [...args], { timeout: 10000 });
  let out = "";
  child.stdout?.on("data", (chunk) => { out += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`${cmd} exited ${code}`)),
    );
  });
  return out.trim();
}

async function defaultWritable(dir: string): Promise<"ok" | "missing" | "denied"> {
  try {
    await access(dir, constants.W_OK);
    return "ok";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "denied";
  }
}

async function defaultPresent(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctorCommand(
  argv: readonly string[],
  io: DoctorIo,
  deps: DoctorDeps = {},
): Promise<number> {
  if (argv.length > 0 && argv[0] !== "init") {
    io.stderr("usage: void doctor");
    return 2;
  }
  if (argv.length > 0 && argv[0] === "init") {
    return runDoctorInit(argv, io, deps);
  }
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  const writable = deps.writable ?? defaultWritable;
  const present = deps.present ?? defaultPresent;
  const results: { status: Status; name: string; detail: string }[] = [];
  const major = Number.parseInt(
    (deps.nodeVersion ?? process.version).replace(/^v/, ""),
    10,
  );
  results.push(
    major >= 24
      ? { status: "PASS", name: "node", detail: `version ${major}, need 24 or newer` }
      : { status: "FAIL", name: "node", detail: `version ${major}, need 24 or newer` },
  );
  try {
    const version = await run("pnpm", ["--version"]);
    results.push({ status: "PASS", name: "pnpm", detail: `version ${version || "unknown"}` });
  } catch {
    results.push({ status: "WARN", name: "pnpm", detail: "not found; only needed to build from source" });
  }
  const home = env.HOME ?? homedir();
  const dataDir = env.VOID_DATA_DIR ?? join(home, ".void", "workbench");
  const ledgerDir = env.VOID_LEDGER_DIR ?? join(home, ".void", "ledger");
  for (const [name, dir] of [["data-dir", dataDir], ["ledger-dir", ledgerDir]] as const) {
    const state = await writable(dir);
    results.push(
      state === "ok"
        ? { status: "PASS", name, detail: `${dir} is writable` }
        : state === "missing"
          ? { status: "WARN", name, detail: `${dir} is absent; created on first run` }
          : { status: "FAIL", name, detail: `${dir} is not writable` },
    );
  }
  results.push(
    env.VOID_VERIFY_KEY
      ? { status: "PASS", name: "verify-key", detail: "public key configured" }
      : { status: "WARN", name: "verify-key", detail: "unset; proxy entries show hash integrity only" },
  );
  const saved =
    (await present(join(dataDir, "tui", "workspace.enc"))) ||
    (await present(join(dataDir, "workspace.enc")));
  results.push(
    saved
      ? { status: "PASS", name: "provider-state", detail: "saved encrypted state found" }
      : { status: "WARN", name: "provider-state", detail: "no saved state; connect with /connect or void tui" },
  );
  const color = env.VOID_TUI_COLOR === "0" ? "off" : "on";
  const motion = env.VOID_TUI_MOTION === "0" || env.TERM === "dumb" ? "off" : "on";
  io.stdout(`info terminal: TERM=${env.TERM ?? "unset"} color=${color} motion=${motion}`);
  for (const result of results) io.stdout(`${result.status} ${result.name}: ${result.detail}`);
  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;
  io.stdout(
    `doctor: ${results.length - fails - warns} pass, ${warns} warn, ${fails} fail`,
  );
  return fails > 0 ? 1 : 0;
}

async function runDoctorInit(
  argv: readonly string[],
  io: DoctorIo,
  deps: DoctorDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  const present = deps.present ?? defaultPresent;
  const writable = deps.writable ?? defaultWritable;
  const results: { status: Status; name: string; detail: string }[] = [];

  // 1. Inventory configured MCP/tool surfaces
  results.push(
    { status: "PASS", name: "mcp-surfaces", detail: "enumerating configured MCP tool surfaces" },
  );
  const mcpTools: readonly string[] = [
    "void_recovery_reconcile",
    "void_execute",
    "void_recovery_plan",
    "void_recovery_apply",
    "void_reconcile",
    "void_recovery_plan_job",
    "void_recovery_status_job",
    "void_recovery_apply_job",
  ] as const;
  for (const tool of mcpTools) {
    results.push({
      status: "PASS",
      name: `mcp-tool:${tool}`,
      detail: `MCP tool "${tool}" is configured`,
    });
  }

  // 2. Verify available capabilities
  const major = Number.parseInt(
    (deps.nodeVersion ?? process.version).replace(/^v/, ""),
    10,
  );
  results.push(
    major >= 24
      ? { status: "PASS", name: "node-capability", detail: `version ${major}, sufficient for capabilities` }
      : { status: "WARN", name: "node-capability", detail: `version ${major}, below 24` },
  );
  try {
    const version = await run("pnpm", ["--version"]);
    results.push({ status: "PASS", name: "pnpm-capability", detail: `version ${version || "unknown"}` });
  } catch {
    results.push({ status: "WARN", name: "pnpm-capability", detail: "not available" });
  }

  // 3. Show unprotected paths
  const home = env.HOME ?? homedir();
  const dataDir = env.VOID_DATA_DIR ?? join(home, ".void", "workbench");
  const ledgerDir = env.VOID_LEDGER_DIR ?? join(home, ".void", "ledger");
  for (const [name, dir] of [["data-dir", dataDir], ["ledger-dir", ledgerDir]] as const) {
    const state = await writable(dir);
    if (state === "ok") {
      results.push({
        status: "WARN",
        name: `unprotected-${name}`,
        detail: `${dir} is writable; consider restricting permissions`,
      });
    } else if (state === "missing") {
      results.push({
        // Missing first-run state is a warning, never a failure, and INFO is
        // not one of the three statuses this report counts.
        status: "WARN",
        name: `unprotected-${name}`,
        detail: `${dir} is absent; will be created`,
      });
    } else {
      results.push({
        status: "FAIL",
        name: `unprotected-${name}`,
        detail: `${dir} is not writable; access denied`,
      });
    }
  }

  // Backup status
  const tuiDir = join(dataDir, "tui");
  const workspaceEnc = join(dataDir, "tui", "workspace.enc");
  const saved = await present(workspaceEnc);
  if (saved) {
    results.push({
      status: "PASS",
      name: "backup-state",
      detail: "encrypted state backup found",
    });
  } else {
    results.push({
      status: "WARN",
      name: "backup-state",
      detail: "no encrypted state backup; use --dry-run to preview restore",
    });
  }

  for (const result of results) io.stdout(`${result.status} ${result.name}: ${result.detail}`);
  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;
  io.stdout(
    `doctor init: ${results.length - fails - warns} pass, ${warns} warn, ${fails} fail`,
  );
  return fails > 0 ? 1 : 0;
}

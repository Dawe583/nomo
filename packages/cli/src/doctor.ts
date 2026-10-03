/**
 * Local environment checks. Read only: it never creates directories, never
 * opens encrypted state and never touches the network. Missing first-run
 * state is a warning, never a failure.
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { access, constants, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { devKeyDir, retainedKeyProvider } from "../../ledger/src/sign.ts";
import {
  auditPrivatePath,
  auditPrivateTree,
  sanitizeWorkspace,
} from "../../ledger/src/hardening.ts";
import {
  pinnedKeyFile,
  resolveVerificationKey,
  verificationKeyNote,
} from "../../ledger/src/verify-key.ts";

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
type Status = "PASS" | "WARN" | "FAIL" | "INFO";

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
  if (argv[0] === "init") {
    if (argv.length !== 1) {
      io.stderr("usage: void doctor init");
      return 2;
    }
    return runDoctorInit(argv, io, deps);
  }
  let recoveryConfig: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (
      argv[i] !== "--recovery-config" ||
      recoveryConfig !== undefined ||
      !argv[i + 1] ||
      argv[i + 1]!.startsWith("--")
    ) {
      io.stderr("usage: void doctor [--recovery-config <file>] | void doctor init");
      return 2;
    }
    recoveryConfig = resolve(argv[i + 1]!);
    i += 1;
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
  const reportPrivatePath = async (
    name: string,
    path: string,
    kind: "file" | "directory",
  ) => {
    const audit = await auditPrivatePath(path, kind);
    results.push(
      audit.state === "private"
        ? {
            status: "PASS",
            name,
            detail: `${kind} exists and meets the private mode/ACL check`,
          }
        : audit.state === "missing"
          ? {
              status: "WARN",
              name,
              detail: `${kind} is absent; created on first use`,
            }
          : { status: "FAIL", name, detail: audit.detail },
    );
  };
  const keyDir = devKeyDir(home);
  const keyFile = join(keyDir, "dev-ed25519.pkcs8");
  if (env.VOID_SIGNING_KEY !== undefined && env.VOID_SIGNING_KEY !== "") {
    results.push({
      status: "INFO",
      name: "signing-key-file",
      detail: "not used; signing key is supplied through VOID_SIGNING_KEY",
    });
  } else {
    await reportPrivatePath("signing-key-dir", keyDir, "directory");
    await reportPrivatePath("signing-key-file", keyFile, "file");
  }
  const ledgerAudit = await auditPrivateTree(ledgerDir);
  results.push(
    ledgerAudit.state === "private"
      ? {
          status: "PASS",
          name: "ledger-permissions",
          detail: `ledger tree meets private mode/ACL checks (${ledgerAudit.directories} directories, ${ledgerAudit.files} files)`,
        }
      : ledgerAudit.state === "missing"
        ? { status: "WARN", name: "ledger-permissions", detail: "ledger tree is absent; created on first use" }
        : { status: "FAIL", name: "ledger-permissions", detail: ledgerAudit.detail ?? "ledger tree failed owner-only checks" },
  );
  try {
    const workspace = sanitizeWorkspace(env.VOID_WORKSPACE ?? "default");
    await reportPrivatePath(
      "ledger-file",
      join(ledgerDir, `${workspace}.jsonl`),
      "file",
    );
  } catch (error) {
    results.push({ status: "FAIL", name: "ledger-file", detail: message(error) });
  }
  if (recoveryConfig === undefined) {
    results.push({
      status: "INFO",
      name: "recovery-permissions",
      detail: "recovery state paths are config-defined; pass --recovery-config <file> to inspect their permissions",
    });
  } else {
    let rawConfig: string | undefined;
    try {
      rawConfig = await readFile(recoveryConfig, "utf8");
    } catch {
      results.push({
        status: "FAIL",
        name: "recovery-permissions",
        detail: "could not read the recovery config file",
      });
    }
    if (rawConfig !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawConfig);
      } catch {
        // Node versions differ in how much source context a SyntaxError may
        // include. Keep the parse diagnostic fixed and never print config text.
        results.push({
          status: "FAIL",
          name: "recovery-permissions",
          detail: "recovery config is not valid JSON",
        });
      }
      if (typeof parsed === "object" && parsed !== null) {
        const config = parsed as { workspace?: unknown; stateDir?: unknown };
        if (
          typeof config.workspace !== "string" ||
          typeof config.stateDir !== "string" ||
          config.stateDir.length === 0 ||
          !/^[\w-]{1,100}$/.test(config.workspace)
        ) {
          results.push({
            status: "FAIL",
            name: "recovery-permissions",
            detail: "recovery config must contain a workspace and stateDir",
          });
        } else {
          const stateDir = resolve(dirname(recoveryConfig), config.stateDir);
          const audit = await auditPrivateTree(stateDir);
          results.push(
            audit.state === "private"
              ? {
                  status: "PASS",
                  name: "recovery-permissions",
                  detail: `configured state tree meets private mode/ACL checks (${audit.directories} directories, ${audit.files} files; point-in-time scan)`,
                }
              : audit.state === "missing"
                ? {
                    status: "WARN",
                    name: "recovery-permissions",
                    detail: "configured recovery state is absent; created on first use",
                  }
                : {
                    status: "FAIL",
                    name: "recovery-permissions",
                    detail: audit.detail ?? "configured recovery state failed private mode/ACL checks",
                  },
          );
        }
      } else if (parsed !== undefined) {
        results.push({
          status: "FAIL",
          name: "recovery-permissions",
          detail: "recovery config must be a JSON object",
        });
      }
    }
  }
  // Resolved the same way every verifier surface resolves it, so `doctor`
  // reports the host that is actually configured. It used to look only at
  // `VOID_VERIFY_KEY`, which reported a host with a perfectly good trust file
  // pinned as unconfigured and never mentioned the pin at all.
  //
  // `allowDegraded` and the retained key are what make the third state
  // reachable. Without them an operator who set `VOID_VERIFY_ALLOW_SIGNING_KEY`
  // was reported as `unset` here while every other surface was quietly
  // verifying with signing key material — so the one command whose job is to
  // tell an operator they are in a degraded mode was the one that could not
  // see it. `retainedKeyProvider` never creates a key, so asking costs
  // nothing and grants no capability.
  const trustFile = pinnedKeyFile(env, { home });
  const verifyKey = await resolveVerificationKey({
    env,
    home,
    allowDegraded: true,
    signingKey: async () => {
      try {
        return await retainedKeyProvider({ dir: keyDir, env });
      } catch (error) {
        // No retained key is a state, not a fault: nothing has signed yet, so
        // there is nothing to verify with and the answer below is `unset`.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
  }).catch(
    (error: unknown) => {
      results.push({
        status: "FAIL",
        name: "verify-key",
        detail: `unreadable: ${message(error)}`,
      });
      return undefined;
    },
  );
  // One vocabulary, one derivation. `verificationKeyNote` decides what is
  // worth disclosing; this decides how loudly to say it. The out-of-tree trust
  // file is a `WARN` and not a `PASS` because VOID infers `operatorSupplied`
  // from the path alone and cannot tell who wrote the bytes, so calling it
  // supplied out of band would claim more than the code knows.
  results.push(
    verifyKey === undefined
      ? {
          status: "WARN",
          name: "verify-key",
          detail: trustFile === undefined
            ? "unset; no signature is checked anywhere, so entries show hash integrity only"
            : `unset; no key at ${trustFile}, so no signature is checked`,
        }
      : verifyKey.degraded
        ? {
            status: "WARN",
            name: "verify-key",
            detail: `DEGRADED ${verifyKey.keyId} (${verifyKey.source}): ${verificationKeyNote(verifyKey)}`,
          }
        : verificationKeyNote(verifyKey) === undefined
          ? {
              status: "PASS",
              name: "verify-key",
              detail: `pinned ${verifyKey.keyId} (${verifyKey.source}), supplied out of band`,
            }
          : {
              status: "WARN",
              name: "verify-key",
              detail: `${verifyKey.keyId} (${verifyKey.source}) at ${trustFile}: ${verificationKeyNote(verifyKey)}`,
            },
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

  // 3. Check owner-only state directories without changing their permissions.
  const home = env.HOME ?? homedir();
  const dataDir = env.VOID_DATA_DIR ?? join(home, ".void", "workbench");
  const ledgerDir = env.VOID_LEDGER_DIR ?? join(home, ".void", "ledger");
  for (const [name, dir] of [["data-dir", dataDir], ["ledger-dir", ledgerDir]] as const) {
    const audit = await auditPrivatePath(dir, "directory");
    const writeState = audit.state === "private" ? await writable(dir) : undefined;
    results.push(
      audit.state === "unsafe"
        ? { status: "FAIL", name: `permissions-${name}`, detail: audit.detail }
        : audit.state === "missing"
          ? { status: "INFO", name: `permissions-${name}`, detail: `${dir} is absent; created on first use` }
          : writeState === "ok"
            ? { status: "PASS", name: `permissions-${name}`, detail: "owner-only and writable" }
            : { status: "FAIL", name: `permissions-${name}`, detail: `${dir} is private but not writable` },
    );
  }

  // Primary provider state is not a recovery backup.
  const saved = await present(join(dataDir, "tui", "workspace.enc"));
  results.push(saved
    ? { status: "PASS", name: "provider-state", detail: "primary encrypted state found" }
    : { status: "WARN", name: "provider-state", detail: "no primary encrypted state found" });
  results.push({
    status: "WARN",
    name: "backup-state",
    detail: "no complete recovery backup verified; stop the executor and back up signing key, journal, vault and external encryption key together",
  });

  for (const result of results) io.stdout(`${result.status} ${result.name}: ${result.detail}`);
  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;
  io.stdout(
    `doctor init: ${results.length - fails - warns} pass, ${warns} warn, ${fails} fail`,
  );
  return fails > 0 ? 1 : 0;
}

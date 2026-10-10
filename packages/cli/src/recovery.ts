import { managedGitAdapter } from "../../connectors/src/git/managed.ts";
import { managedFilesystemAdapter } from "../../connectors/src/filesystem/managed.ts";
import { assertRecoveryStateOutsideRoot } from "./recovery-paths.ts";
import { runConformanceCommand } from "./conformance.ts";
import { inspectRecoveryHealth } from "./recovery-health.ts";
import { readFile, readdir, lstat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { devKeyProvider, retainedKeyProvider } from "../../ledger/src/sign.ts";
import {
  recoveryRuntime,
  localOperationJournal,
  reservedRecoveryVault,
  digest,
  type ExecutionRequest,
  type RecoveryPlan,
  type RecoveryJobRequest,
} from "../../runtime/src/index.ts";
import {
  managedPostgresAdapter,
  installManagedPostgres,
  migrateManagedPostgres,
  type ManagedPostgresOptions,
} from "../../connectors/src/postgres/managed.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { recoveryMcpServer } from "./recovery-mcp.ts";
import { loadPolicy, decide } from "../../policy/src/index.ts";
import {
  describeRecoveryConfig,
  recoveryConfigRefusal,
  renderRecoveryConfigReport,
} from "./recovery-config.ts";
import { postgresExecutor } from "./postgres.ts";
/**
 * The operator's mode for this workspace, mirrored from the workbench's
 * `permissionMode` so the same operator gets the same control on the path that
 * actually changes files. `audit` and `plan` refuse dispatch regardless of
 * policy, so a mode is something an operator can widen by editing one field
 * and not something a policy edit can widen by accident.
 */
export type RecoveryMode = "audit" | "plan" | "normal";

type Config = {
  vaultCapacity?: { maxArtifactBytes: number; maxTotalBytes: number };
  policyPath?: string;
  agentId?: string;
  /** Absent means `normal`, which is what an unconfigured workspace has always
   * done. The default is unchanged on purpose: a mode that silently narrowed a
   * working configuration would be a behaviour change, not a safety feature. */
  mode?: RecoveryMode;
  workspace: string;
  stateDir: string;
  encryptionKeyEnv: string;
  filesystem?: { root: string; cooperative: true };
  git?: { root: string; cooperative: true };
  postgres?: {
    schema: string;
    tables: ManagedPostgresOptions["tables"];
    urlEnv: string;
  };
};
export async function runRecoveryCommand(
  argv: readonly string[],
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  print: (s: string) => void = console.log,
): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "conformance") return runConformanceCommand(rest, print);
  const args = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    if (
      !["--config", "--input", "--approve"].includes(rest[i] ?? "") ||
      !rest[i + 1] ||
      args.has(rest[i]!)
    )
      throw new Error("Invalid recovery arguments.");
    args.set(rest[i]!, rest[i + 1]!);
  }
  if (
    ![
      "install",
      "migrate",
      "health",
      "inspect",
      "execute",
      "plan",
      "plan-job",
      "apply-job",
      "status-job",
      "doctor",
      "apply",
      "reconcile",
      "reconcile-recovery",
      "serve",
    ].includes(action ?? "") ||
    !args.get("--config")
  )
    throw new Error(
      "usage: nomo recovery conformance [--adapter filesystem.managed] OR nomo recovery doctor --config file OR nomo recovery <install|migrate|health|inspect|execute|plan|plan-job|apply-job|status-job|apply|reconcile|reconcile-recovery|serve> --config file [--input file] [--approve digest]",
    );
  const configPath = resolve(args.get("--config")!),
    config = JSON.parse(await readFile(configPath, "utf8")) as Config;
  // `doctor` describes the file and stops there. It is the surface that answers
  // "which field is wrong", so it must not need the rest of the configuration
  // to be valid, and it must not need --input.
  if (action === "doctor") {
    const report = describeRecoveryConfig(config, configPath);
    print(renderRecoveryConfigReport(configPath, report));
    return report.valid ? 0 : 1;
  }
  // Every other action refuses with the same description, so the reason a
  // command stopped is the report `nomo recovery doctor` would have printed.
  const described = describeRecoveryConfig(config, configPath);
  if (!described.valid) throw new Error(recoveryConfigRefusal(described));
  if (action === "health") {
    const configuredKey = env[config.encryptionKeyEnv];
    const report = await inspectRecoveryHealth({
      stateDir: resolve(dirname(configPath), config.stateDir),
      workspace: config.workspace,
      adapter: config.postgres
        ? { id: `postgres-managed-${config.workspace}`, version: "2" }
        : config.git
          ? { id: "git.managed", version: "1" }
          : { id: "filesystem.managed", version: "1" },
      ...(configuredKey === undefined
        ? {}
        : { encryptionKey: Buffer.from(configuredKey, "base64") }),
    });
    // The effective mode is part of the health report so an operator can see
    // it without reading the config file, and so a restricted workspace is
    // never mistaken for a broken one.
    print(JSON.stringify({ ...report, mode: config.mode ?? "normal" }));
    return report.status === "unavailable" || report.status === "unsafe" ? 1 : 0;
  }
  const mode: RecoveryMode = config.mode ?? "normal";
  const postgres = config.postgres;
  const url = postgres ? env[postgres.urlEnv] : undefined;
  if (postgres && !url)
    throw new Error("Configured Postgres URL environment variable is absent.");
  const options: ManagedPostgresOptions | undefined = postgres
    ? {
        workspace: config.workspace,
        schema: postgres.schema,
        tables: postgres.tables,
        connect: () => postgresExecutor(url!),
      }
    : undefined;
  if (action === "install") {
    if (!options)
      throw new Error(
        "Filesystem and Git need no installation. Configure an existing cooperative root.",
      );
    const installed = await installManagedPostgres(options);
    print(
      JSON.stringify({
        installed: true,
        workspace: config.workspace,
        tables: installed.installedTables,
        metadataVersion: installed.metadataVersion,
        migration:
          "fresh-install-v2; existing metadata requires explicit reviewed migration",
      }),
    );
    return 0;
  }
  if (action === "migrate") {
    if (!options)
      throw new Error(
        "Filesystem and Git do not use PostgreSQL metadata migration.",
      );
    print(JSON.stringify(await migrateManagedPostgres(options)));
    return 0;
  }
  if (action !== "serve" && !args.get("--input"))
    throw new Error("--input is required.");
  const input =
    action === "serve"
      ? { workspace: config.workspace }
      : JSON.parse(await readFile(resolve(args.get("--input")!), "utf8"));
  if (input.workspace !== config.workspace)
    throw new Error("Input belongs to another workspace.");
  if (config.filesystem || config.git) {
    const root = resolve(dirname(configPath), (config.filesystem ?? config.git)!.root);
    const state = resolve(dirname(configPath), config.stateDir);
    await assertRecoveryStateOutsideRoot(root, state);
  }
  const adapter = options
    ? managedPostgresAdapter(options)
    : config.git
      ? managedGitAdapter({
          root: resolve(dirname(configPath), config.git.root),
          cooperative: config.git.cooperative,
        })
      : managedFilesystemAdapter({
          root: resolve(dirname(configPath), config.filesystem!.root),
          cooperative: config.filesystem!.cooperative,
        });
  if (action === "inspect") {
    const request = input as ExecutionRequest;
    if (request.adapterId !== adapter.id)
      throw new Error("Adapter does not match configuration.");
    const observation = await adapter.preflight(request.arguments);
    print(
      JSON.stringify(
        {
          request,
          observation,
          approvalDigest: digest({
            requestDigest: digest(request),
            adapterVersion: adapter.version,
            observation,
          }),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const state = resolve(dirname(configPath), config.stateDir),
    key = Buffer.from(env[config.encryptionKeyEnv] ?? "", "base64");
  if (key.length !== 32)
    throw new Error(
      "Configured recovery encryption key must be 32 bytes in base64.",
    );
  const keyPath = join(state, "keys", "dev-ed25519.pkcs8");
  let retainedState = false;
  try {
    await lstat(keyPath);
    retainedState = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const entries = await readdir(state).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    });
    const keyEntries = await readdir(join(state, "keys")).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return [];
      throw cause;
    });
    retainedState =
      entries.some((entry) => entry !== "keys") || keyEntries.length > 0;
    if (retainedState)
      throw new Error("Retained recovery signing key is unavailable; restore the original key before continuing.");
  }
  let signer;
  try {
    signer = retainedState
      ? await retainedKeyProvider({ dir: join(state, "keys"), env: {} })
      : await devKeyProvider({
          dir: join(state, "keys"),
          env: {},
          createIfMissing: true,
        });
  } catch (error) {
    if (
      retainedState &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      throw new Error("Retained recovery signing key is unavailable; restore the original key before continuing.");
    throw error;
  }
  const policy = async () => {
    if (!config.policyPath)
      return { ok: false, errors: ["No policy configured."] } as const;
    return loadPolicy(
      await readFile(resolve(dirname(configPath), config.policyPath), "utf8"),
    );
  };
  const allowed = async (
    tool: string,
    klass: string,
    blastRadius: number | undefined,
  ) => {
    try {
      const loaded = await policy();
      return (
        loaded.ok &&
        decide(loaded, {
          tool,
          connector: options ? "postgres" : config.git ? "git" : "filesystem",
          workspace: config.workspace,
          klass,
          blastRadius,
        }).kind === "allow"
      );
    } catch {
      return false;
    }
  };
  const runtime = recoveryRuntime({
    journal: localOperationJournal(join(state, "journal"), signer),
    vault: reservedRecoveryVault(
      join(state, "vault"),
      { local: key },
      "local",
      config.vaultCapacity,
    ),
    adapters: [adapter],
    authorize: async (proposal) => {
      // A mode that forbids dispatch forbids it here, before the policy is
      // consulted, so widening the policy cannot widen the mode.
      if (mode !== "normal" && proposal.observation.effect !== "read")
        return false;
      return action === "serve"
        ? allowed(
            "nomo_execute",
            proposal.observation.reversibility,
            proposal.observation.blastRadius.count ?? undefined,
          )
        : args.get("--approve") === proposal.digest;
    },
  });
  if (action === "serve") {
    if (!config.agentId || !/^[\w-]{1,120}$/.test(config.agentId))
      throw new Error("A stable agentId is required for MCP.");
    const server = recoveryMcpServer({
      runtime,
      workspace: config.workspace,
      agentId: config.agentId,
      adapterId: adapter.id,
      permitted: (tool) =>
        allowed(
          tool,
          tool === "nomo_recovery_plan" ? "r0" : "r1",
          tool === "nomo_recovery_plan" ? 0 : 1,
        ),
    });
    await server.connect(new StdioServerTransport());
    return 0;
  }
  if (action === "execute") {
    if (!args.has("--approve"))
      throw new Error(
        "Inspect the request and supply its exact --approve digest.",
      );
    const result = await runtime.execute(input as ExecutionRequest);
    print(JSON.stringify(result));
    return result.status === "succeeded" ? 0 : 1;
  }
  if (action === "plan-job") {
    print(
      JSON.stringify(
        await runtime.planRecoveryJob(input as RecoveryJobRequest),
        null,
        2,
      ),
    );
    return 0;
  }
  if (action === "status-job") {
    print(
      JSON.stringify(
        await runtime.recoveryJobStatus(config.workspace, input.jobId),
        null,
        2,
      ),
    );
    return 0;
  }
  if (action === "apply-job") {
    if (!args.has("--approve"))
      throw new Error(
        "Review the recovery job plan and supply its exact --approve digest.",
      );
    const result = await runtime.runRecoveryJob(
      config.workspace,
      input.jobId,
      async (plan) => args.get("--approve") === plan.digest,
    );
    print(JSON.stringify(result));
    return result.status === "restored" || result.status === "partial" ? 0 : 1;
  }
  if (action === "plan") {
    print(
      JSON.stringify(
        await runtime.planRecovery(config.workspace, input.operationId),
        null,
        2,
      ),
    );
    return 0;
  }
  if (action === "reconcile-recovery") {
    const result = await runtime.reconcileRecovery(
      config.workspace,
      input.operationId,
    );
    print(JSON.stringify(result));
    return result.status === "restored" || result.status === "compensated"
      ? 0
      : 1;
  }
  if (action === "reconcile") {
    const result = await runtime.reconcile(config.workspace, input.operationId);
    print(JSON.stringify(result));
    return result.status === "succeeded" ? 0 : 1;
  }
  if (!args.has("--approve"))
    throw new Error(
      "Review the recovery plan and supply its exact --approve digest.",
    );
  const result = await runtime.recover(
    input as RecoveryPlan,
    async (plan) => args.get("--approve") === plan.digest,
  );
  print(JSON.stringify(result));
  return result.status === "restored" || result.status === "compensated"
    ? 0
    : 1;
}

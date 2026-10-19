import { managedGitAdapter } from "../../connectors/src/git/managed.ts";
import { managedFilesystemAdapter } from "../../connectors/src/filesystem/managed.ts";
import { assertRecoveryStateOutsideRoot } from "./recovery-paths.ts";
import { runConformanceCommand } from "./conformance.ts";
import {
  inspectRecoveryHealth,
  recoveryHealthExitCode,
} from "./recovery-health.ts";
import { readFile, readdir, lstat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { devKeyProvider, retainedKeyProvider } from "../../ledger/src/sign.ts";
import {
  recoveryRuntime,
  localOperationJournal,
  reservedRecoveryVault,
  auditReservedVaultCollection,
  collectReservedVaultGarbage,
  validateRetentionPolicy,
  digest,
  collectVaultGarbage,
  type ExecutionRequest,
  type RecoveryPlan,
  type RecoveryJobRequest,
} from "../../runtime/src/index.ts";
import { auditFileVaultCollection } from "../../runtime/src/file-retention.ts";
import {
  managedPostgresAdapter,
  installManagedPostgres,
  migrateManagedPostgres,
  type ManagedPostgresOptions,
} from "../../connectors/src/postgres/managed.ts";
import {
  listFileVaultRetention,
  listReservedVaultRetention,
  markFileVaultUnpinned,
  pinFileVaultLifecycle,
  releaseFileVaultPin,
  reservedVaultReference,
  type RetentionRow,
} from "./recovery-retention.ts";
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

/** A retention policy arrives as JSON at a boundary, so a parse failure names
 * the file it came from and the schema check names the field, exactly as the
 * recovery config refusals do. */
const readRetentionPolicy = async (path: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`The retention policy is not valid JSON: ${path}`);
  }
  return validateRetentionPolicy(parsed);
};

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
  let dryRun = false;
  let listOnly = false;
  for (let i = 0; i < rest.length; ) {
    if (rest[i] === "--dry-run" || (action === "retention" && rest[i] === "--list")) {
      // Bare flags: a prediction and a listing carry no value, so a
      // `--dry-run file` typo on the next token would otherwise be parsed
      // as one.
      if (rest[i] === "--dry-run") {
        if (dryRun) throw new Error("Invalid recovery arguments.");
        dryRun = true;
      } else {
        // --list is parsed as its own bare flag and rejected again in the
        // retention block when it collides with a transition. The flag must
        // not ride along on --dry-run: a prediction flag that also sets the
        // listing turned every retention transition into a lying
        // "names exactly one of" refusal.
        listOnly = true;
      }
      i += 1;
      continue;
    }
    if (
      ![
        "--config",
        "--input",
        "--approve",
        "--retention-policy",
        "--operation",
        "--surface",
        "--as",
        "--pins",
        "--kind",
        "--pin",
        "--mark-unpinned",
        "--release",
        "--from",
        "--to",
      ].includes(
        rest[i] ?? "",
      ) ||
      !rest[i + 1] ||
      args.has(rest[i]!)
    )
      throw new Error("Invalid recovery arguments.");
    args.set(rest[i]!, rest[i + 1]!);
    i += 2;
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
      "collect",
      "retention",
      "vault-capacity",
    ].includes(action ?? "") ||
    !args.get("--config")
  )
    throw new Error(
      "usage: nomo recovery conformance [--adapter filesystem.managed] OR nomo recovery doctor --config file OR nomo recovery <install|migrate|health|inspect|execute|plan|plan-job|apply-job|status-job|apply|reconcile|reconcile-recovery|serve|collect> --config file [--input file] [--approve digest] [--retention-policy file] [--operation id] [--surface file|reserved|both] [--dry-run] OR nomo recovery retention --config file (--list | (--pin|--mark-unpinned|--release) <digest> --as <owner> [--kind recovery|operator] [--pins owner:kind]) OR nomo recovery vault-capacity --config file --from <total>:<artifact> --to <total>:<artifact> --as <owner>",
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
    return recoveryHealthExitCode(report.status);
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
  // Collect needs no operation input: the policy file, not the input, is what
  // it reads, and the workspace comes from the configuration.
  const input =
    action === "serve"
      ? { workspace: config.workspace }
      : action === "collect" || action === "retention" ||
        action === "vault-capacity"
        ? null
        : JSON.parse(await readFile(resolve(args.get("--input")!), "utf8"));
  if (input !== null && (input as { workspace: unknown }).workspace !== config.workspace)
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
  const journal = localOperationJournal(join(state, "journal"), signer),
    vault = reservedRecoveryVault(
      join(state, "vault"),
      { local: key },
      "local",
      config.vaultCapacity,
    );
  const runtime = recoveryRuntime({
    journal,
    vault,
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
  if (action === "collect") {
    // The invoked command is the authorization: the policy digest and every
    // stage land in the same signed chain as a runtime capture, so a shell
    // delete is audited exactly like a runtime one.
    const policyArg = args.get("--retention-policy"),
      policy = policyArg
        ? await readRetentionPolicy(resolve(dirname(configPath), policyArg))
        : undefined,
      stamp = Date.now().toString(36);
    const surfaceArg = args.get("--surface");
    if (surfaceArg !== undefined && !["file", "reserved", "both"].includes(surfaceArg))
      throw new Error("The collect surface must be file, reserved, or both.");
    const surface = surfaceArg ?? "reserved";
    // The legacy file artifacts share the reserved vault's root: workspace
    // directories sit beside vault.sqlite there, and the retention evidence
    // for them must therefore live outside it in its own index directory.
    const fileRoot = join(state, "vault"),
      fileIndex = join(state, "retention-index");
    if (dryRun) {
      // A prediction opens no journal chain and signs nothing: the chain is
      // the evidence a delete happened, so a run that deletes nothing must
      // never leave one behind as if it had.
      const printAudit = async () => {
        const reserved =
          surface === "file"
            ? undefined
            : await auditReservedVaultCollection({
                workspace: config.workspace,
                ...(policy === undefined ? {} : { policy }),
                vault,
              });
        const file =
          surface === "reserved"
            ? undefined
            : await auditFileVaultCollection({
                root: fileRoot,
                index: fileIndex,
                workspace: config.workspace,
                ...(policy === undefined ? {} : { policy }),
              });
        if (file === undefined)
          return JSON.stringify(
            { dryRun: true, mode: policy?.mode ?? "manual", ...reserved },
            null,
            2,
          );
        return JSON.stringify(
          {
            dryRun: true,
            surface,
            mode: policy?.mode ?? "manual",
            ...(reserved === undefined ? {} : { reserved }),
            file,
          },
          null,
          2,
        );
      };
      print(await printAudit());
      return 0;
    }
    if (surface === "reserved") {
      const garbage = await collectReservedVaultGarbage({
        workspace: config.workspace,
        journal,
        vault,
        operationId: args.get("--operation") ?? `collect-${stamp}`,
        agentId: config.agentId ?? "operator",
        runId: `collect-${stamp}`,
        ...(policy === undefined ? {} : { policy }),
        authorize: async () => true,
      });
      print(JSON.stringify({ mode: policy?.mode ?? "manual", ...garbage }, null, 2));
      return 0;
    }
    // Each surface gets its own operation id suffix, so the two chains stay
    // independently verifiable rather than interleaving stages of unrelated
    // stores under one id.
    const baseId = args.get("--operation") ?? `collect-${stamp}`;
    if (surface === "file") {
      const garbage = await collectVaultGarbage({
        root: fileRoot,
        index: fileIndex,
        workspace: config.workspace,
        journal,
        operationId: `${baseId}-file`,
        agentId: config.agentId ?? "operator",
        runId: `collect-${stamp}`,
        ...(policy === undefined ? {} : { policy }),
        authorize: async () => true,
      });
      print(
        JSON.stringify({ surface: "file", mode: policy?.mode ?? "manual", ...garbage }, null, 2),
      );
      return 0;
    }
    const reserved = await collectReservedVaultGarbage({
      workspace: config.workspace,
      journal,
      vault,
      operationId: `${baseId}-reserved`,
      agentId: config.agentId ?? "operator",
      runId: `collect-${stamp}`,
      ...(policy === undefined ? {} : { policy }),
      authorize: async () => true,
    });
    const file = await collectVaultGarbage({
      root: fileRoot,
      index: fileIndex,
      workspace: config.workspace,
      journal,
      operationId: `${baseId}-file`,
      agentId: config.agentId ?? "operator",
      runId: `collect-${stamp}`,
      ...(policy === undefined ? {} : { policy }),
      authorize: async () => true,
    });
    print(
      JSON.stringify({ surface: "both", mode: policy?.mode ?? "manual", reserved, file }, null, 2),
    );
    return 0;
  }
  if (action === "retention") {
    // The prediction flag belongs to collect: a retention transition
    // records what it runs, so --dry-run here must refuse with the
    // surface named instead of being read as a listing or ignored.
    if (dryRun)
      throw new Error(
        "--dry-run predicts a collect run; a retention transition has no prediction mode.",
      );
    // Exactly one transition runs per invocation, so a half-typed command
    // cannot move two different protections at once.
    const surfaceArg = args.get("--surface");
    if (surfaceArg !== undefined && !["file", "reserved", "both"].includes(surfaceArg))
      throw new Error("The retention surface must be file, reserved, or both.");
    const surface = (surfaceArg ?? "both") as "file" | "reserved" | "both";
    const listing = listOnly,
      pinned = args.get("--pin"),
      unpinned = args.get("--mark-unpinned"),
      released = args.get("--release");
    if (
      [listing, pinned !== undefined, unpinned !== undefined, released !== undefined]
        .filter(Boolean).length !== 1
    )
      throw new Error(
        "A retention run names exactly one of --list, --pin, --mark-unpinned, or --release.",
      );
    const digest = pinned ?? unpinned ?? released;
    if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))
      throw new Error("The retention digest must be a sha256 hex digest.");
    const owner = args.get("--as");
    if (
      // A listing names no operator, and the unpinned record names none
      // either: every other transition both requires and records --as.
      !listing &&
      unpinned === undefined &&
      (owner === null || owner === undefined || !/^[\w-]{1,120}$/.test(owner))
    )
      throw new Error("A pin and a release name their operator with --as <id>.");
    const kind = args.get("--kind");
    if (pinned !== undefined && kind !== undefined && kind !== "recovery" && kind !== "operator")
      throw new Error("The pin kind must be recovery or operator.");
    const surfaces: Array<"file" | "reserved"> =
      surface === "both" ? ["file", "reserved"] : [surface];
    const fileRoot = join(state, "vault"),
      fileIndex = join(state, "retention-index");
    if (listing) {
      const rows: Record<"file" | "reserved", RetentionRow[]> = {
        file: [],
        reserved: [],
      };
      for (const piece of surfaces)
        rows[piece] =
          piece === "file"
            ? await listFileVaultRetention({
                root: fileRoot,
                index: fileIndex,
                workspace: config.workspace,
              })
            : await listReservedVaultRetention(vault, config.workspace);
      print(
        JSON.stringify(
          Object.fromEntries(surfaces.map((piece) => [piece, rows[piece]])),
          null,
          2,
        ),
      );
      return 0;
    }
    let believedPin: { ownerId: string; kind: "recovery" | "operator" } | undefined;
    if (released !== undefined) {
      const believed = args.get("--pins");
      const believedFormat = /^[\w-]+:(recovery|operator)$/.exec(believed ?? "");
      if (believedFormat === null)
        throw new Error(
          "A release names the pin it removes with --pins <ownerId>:<kind>.",
        );
      const [believedOwner, believedKind] = believed!
        .split(":") as [string, "recovery" | "operator"];
      believedPin = { ownerId: believedOwner, kind: believedKind };
    }
    // Two stores cannot commit one transition atomically, so this run first
    // learns what every half decided. A mark skips the half that has nothing
    // to protect, while a release keeps its exact interpretation of what
    // the operator stated. The half that proves the digest lands either
    // way, and a refusal after one half recorded names both, because a run
    // whose message denies what did happen trains operators to distrust it.
    const halves: Array<{ surface: "file" | "reserved"; outcome: string }> = [];
    const refusals: string[] = [];
    for (const piece of surfaces) {
      // The absence a healthy store reports comes in one of these two
      // literal forms; a genuine half failure, like a capacity worker or a
      // mismatched pin, names itself differently and must refuse.
      const isAbsent = (message: string): boolean =>
        message === "Recovery artifact is unavailable; lifecycle was not recorded." ||
        message === "Invalid or unavailable recovery reference.";
      try {
        if (pinned !== undefined) {
          const pin = {
            ownerId: owner!,
            kind: (kind ?? "operator") as "recovery" | "operator",
          };
          if (piece === "file")
            await pinFileVaultLifecycle({
              root: fileRoot,
              index: fileIndex,
              workspace: config.workspace,
              digest: pinned,
              pin,
            });
          else
            await vault.markVaultLifecycle(
              config.workspace,
              await reservedVaultReference(vault, config.workspace, pinned),
              { pin },
            );
        } else if (unpinned !== undefined) {
          if (piece === "file")
            await markFileVaultUnpinned({
              root: fileRoot,
              index: fileIndex,
              workspace: config.workspace,
              digest: unpinned,
            });
          else
            await vault.markVaultLifecycle(
              config.workspace,
              await reservedVaultReference(vault, config.workspace, unpinned),
              {},
            );
        } else {
          if (piece === "file")
            await releaseFileVaultPin({
              root: fileRoot,
              index: fileIndex,
              workspace: config.workspace,
              digest: released!,
              pin: believedPin!,
              operatorId: owner!,
            });
          else
            await vault.releaseVaultPin(
              config.workspace,
              await reservedVaultReference(vault, config.workspace, released!),
              { pin: believedPin!, operatorId: owner! },
            );
        }
        halves.push({ surface: piece, outcome: "recorded" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (released === undefined && isAbsent(message)) {
          halves.push({ surface: piece, outcome: "absent" });
          continue;
        }
        refusals.push(`${piece}: ${message}`);
      }
    }
    if (halves.length === surfaces.length && refusals.length === 0 && !halves.some((half) => half.outcome === "recorded"))
      throw new Error("No retention surface names the digest; nothing was recorded.");
    if (refusals.length > 0)
      throw new Error(
        "Retention transition refused: " +
          [
            ...halves.map((half) => `${half.surface} ${half.outcome}`),
            ...refusals,
          ].join("; "),
      );
    print(
      JSON.stringify(
        {
          surface,
          digest,
          transition:
            pinned !== undefined ? "pinned" : unpinned !== undefined ? "unpinned" : "released",
          ...(unpinned === undefined ? { as: owner } : {}),
          halves,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (action === "vault-capacity") {
    // Capacity follows no ordinary use: the persisted ceiling moves only
    // through this command. The operator states both the capacity the vault
    // is believed to hold and the one it must become, the store validates the
    // belief as a compare-and-swap, and the move and its capacity_migrations
    // row commit together or not at all.
    const parseCapacity = (value: string | undefined, flag: string) => {
      const pair = /^(\d+):(\d+)$/.exec(value ?? "");
      if (!pair)
        throw new Error(
          `${flag} states the vault capacity as <maxTotalBytes>:<maxArtifactBytes>.`,
        );
      const total = Number(pair[1]),
        artifact = Number(pair[2]);
      if (total < 1 || artifact < 1)
        throw new Error("The vault capacities must be positive integers.");
      return { maxTotalBytes: total, maxArtifactBytes: artifact };
    };
    const from = parseCapacity(args.get("--from"), "--from"),
      to = parseCapacity(args.get("--to"), "--to");
    const owner = args.get("--as");
    if (owner === null || owner === undefined || !/^[\w-]{1,120}$/.test(owner))
      throw new Error("A capacity move names its operator with --as <id>.");
    // Built at the target on purpose: the migration's compare-and-swap reads
    // the capacity the vault holds instead of the constructed one, and a
    // normal operation on a mismatched worker still refuses, so this move
    // stays the only way the persisted ceiling changes.
    const migration = reservedRecoveryVault(
      join(state, "vault"),
      { local: key },
      "local",
      to,
    );
    const report = await migration.migrateCapacity({
      from,
      operatorId: owner,
    });
    print(JSON.stringify(report, null, 2));
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
